import fs from 'node:fs'
import { verifyTypedData, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { MINTER_ABI, TYPES, domain, publicClient, walletClient } from './evm'
import type { NodeKeys } from './keys'
import { log } from './log'
import { isHeld } from './machine'
import type { AttestMessage, EvmActionKind, EvmActionRec, State } from './types'

/**
 * Node-local half of the EVM side. Attestations (EIP-712 signatures over a
 * mint, a listing or a metadata update) live in `../attestations.json`; the
 * relay is a side effect by one designated node per action; the outcome
 * returns through the EVM feed as an agreed Minted, Listed or Updated event.
 */
const ATT_PATH = '../attestations.json'
const RELAY_TIMEOUT_MS = 8000
/** Rounds to wait before this node relays the same action again. */
const RERELAY_AFTER_ROUNDS = 40
/** A paused minter or an endpoint that refused us is worth asking again soon; everything else keeps the long wait. */
const SOON_ROUNDS = 5

/**
 * What a failed relay attempt means for the next one. `paused` (IsPaused) and `cap-day` (CapExceeded: the day's
 * allowance is spent, or an update lowered the cap) are conditions to wait out, not failures; `already-done` means
 * the minter holds the outcome; `transient` is the network or a node that is behind; `bad-signature` is a held signature the
 * minter refused (the cache is cleared of peers' signatures and they are asked for again); `fatal` is anything else.
 */
export type RelayErrorKind = 'paused' | 'cap-day' | 'already-done' | 'transient' | 'bad-signature' | 'fatal'

export interface AttCache {
  [actionId: string]: {
    sigs: Record<string, Hex>
    /** The last relay attempt: sent (`hash`), refused before sending (`error`, with its `kind`), or found already done on chain (`done`). */
    submitted?: { lcl: number; hash?: string; error?: string; done?: boolean; kind?: RelayErrorKind }
  }
}

/** The custom error viem decoded from the minter's revert, wherever it sits in the error's causes. */
export function revertName(err: unknown): string | undefined {
  for (let e: any = err, i = 0; e && i < 10; e = e.cause, i++) if (typeof e.data?.errorName === 'string') return e.data.errorName
  return undefined
}

export function classifyRelayError(err: unknown, actionKind?: EvmActionKind): RelayErrorKind {
  const name = revertName(err)
  if (name === 'IsPaused') return 'paused'
  if (name === 'CapExceeded') return 'cap-day'
  // BadNonce means done only for an update: the caller confirms with a read (an update whose nonce is merely ahead of the minter's is not done).
  if (name === 'AlreadyMinted' || name === 'TokenExists' || (name === 'BadNonce' && actionKind === 'update')) return 'already-done'
  // The call went to an RPC node that has not seen the listing yet.
  if (name === 'UnknownToken') return 'transient'
  if (name === 'BadSignature' || name === 'SignersNotSorted') return 'bad-signature'
  if (name) return 'fatal'
  let text = ''
  for (let e: any = err, i = 0; e && i < 10; e = e.cause, i++) text += ` ${e.name} ${e.shortMessage ?? e.message}`
  // OpenZeppelin's ECDSA errors are not in the minter's ABI, so viem cannot name them; their selectors show up in the text.
  if (/ECDSAInvalidSignature|0xd78bce0c|0xfce698f7|0xf645eedf/i.test(text)) return 'bad-signature'
  return /HttpRequestError|TimeoutError|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|NonceTooLowError|already known/i.test(text) ? 'transient' : 'fatal'
}

/** Half the secp256k1 group order: OpenZeppelin's ECDSA.recover, which the minter uses, rejects any signature whose s is above it. */
const SECP256K1_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

/**
 * Whether a signature is the one form the minter accepts: 65 bytes, v of 27 or 28, s in the lower half. The curve also
 * verifies (n - s, flipped v) for the same signer, and viem recovers that twin happily, so a check against the signer
 * alone lets one node hand its peers a signature the minter will revert, which then sits in every cache.
 */
export function isCanonicalSignature(sig: unknown): sig is Hex {
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return false
  const s = BigInt(`0x${sig.slice(66, 130)}`)
  const v = parseInt(sig.slice(130, 132), 16)
  return (v === 27 || v === 28) && s > 0n && s <= SECP256K1_N_HALF
}

export function loadAttestations(): AttCache {
  try {
    return JSON.parse(fs.readFileSync(ATT_PATH, 'utf8')) as AttCache
  } catch {
    return {}
  }
}

export function persistAttestations(cache: AttCache, state: State): void {
  for (const id of Object.keys(cache)) if (state.evmActions[id]?.status !== 'pending') delete cache[id]
  try {
    fs.writeFileSync(ATT_PATH, JSON.stringify(cache))
  } catch (e) {
    log(`attestations: cannot save: ${(e as Error).message}`)
  }
}

function operatorAddresses(state: State): string[] {
  return Object.values(state.operators)
    .map((o) => o.evmAddress.toLowerCase())
    .sort()
}

function typed(state: State, action: EvmActionRec) {
  const cfg = state.config.evm!
  if (action.kind === 'mint') {
    const m = action.data as { tokenId: string; to: string; amount: string; srcTx: string }
    return { domain: domain(cfg), types: TYPES, primaryType: 'Mint' as const, message: { tokenId: m.tokenId as Hex, to: m.to as Hex, amount: BigInt(m.amount), srcTx: m.srcTx as Hex } }
  }
  if (action.kind === 'update') {
    const u = action.data as { tokenId: string; name: string; symbol: string; imageURI: string; dailyCap: string; nonce: string }
    return { domain: domain(cfg), types: TYPES, primaryType: 'Update' as const, message: { tokenId: u.tokenId as Hex, name: u.name, symbol: u.symbol, imageURI: u.imageURI, dailyCap: BigInt(u.dailyCap), nonce: BigInt(u.nonce) } }
  }
  const l = action.data as { tokenId: string; name: string; symbol: string; imageURI?: string; dailyCap: string }
  return { domain: domain(cfg), types: TYPES, primaryType: 'List' as const, message: { tokenId: l.tokenId as Hex, name: l.name, symbol: l.symbol, imageURI: l.imageURI ?? '', dailyCap: BigInt(l.dailyCap) } }
}

const RELAY_FUNCTION = { mint: 'mint', list: 'listToken', update: 'updateToken' } as const

/** Signs every pending EVM action this node is an operator for. Idempotent; returns what to broadcast. */
export async function myAttestations(state: State, keys: NodeKeys, cache: AttCache): Promise<AttestMessage[]> {
  const out: AttestMessage[] = []
  if (!state.config.evm) return out
  const me = keys.evm.address.toLowerCase()
  if (!operatorAddresses(state).includes(me)) return out
  const account = privateKeyToAccount(keys.evm.privateKey as Hex)
  for (const action of Object.values(state.evmActions)) {
    if (action.status !== 'pending') continue
    const entry = (cache[action.id] ??= { sigs: {} })
    if (!entry.sigs[me]) {
      try {
        entry.sigs[me] = await account.signTypedData(typed(state, action) as any)
      } catch (e) {
        log(`attest ${action.id}: ${(e as Error).message}`)
        continue
      }
    }
    out.push({ a: action.id, e: me, s: entry.sigs[me] })
  }
  return out
}

export async function ingestAttestations(state: State, cache: AttCache, received: { node: string; att: AttestMessage }[]): Promise<number> {
  if (!state.config.evm) return 0
  const operators = new Set(operatorAddresses(state))
  let added = 0
  for (const { att } of received) {
    const action = state.evmActions[att.a]
    if (!action || action.status !== 'pending') continue
    const signer = att.e.toLowerCase()
    if (!operators.has(signer)) continue
    const entry = (cache[action.id] ??= { sigs: {} })
    if (entry.sigs[signer]) continue
    if (!isCanonicalSignature(att.s)) {
      log(`ingest attestation ${action.id} from ${signer}: not a canonical signature (65 bytes, v 27/28, low s); ignored`)
      continue
    }
    try {
      const ok = await verifyTypedData({ address: signer as Hex, signature: att.s, ...(typed(state, action) as any) })
      if (!ok) throw new Error('bad signature')
    } catch (e) {
      log(`ingest attestation ${action.id} from ${signer}: ${(e as Error).message}`)
      continue
    }
    entry.sigs[signer] = att.s
    added++
  }
  return added
}

/** This node's index in the sorted operator set, or -1. */
export function myOperatorIndex(state: State, keys: NodeKeys): number {
  return operatorAddresses(state).indexOf(keys.evm.address.toLowerCase())
}

/** The minter's signer set and threshold must be the operator set and k, or every relay is wasted gas. Read once per round, only when there is something to relay. */
async function signerSetMatches(state: State, pub: ReturnType<typeof publicClient>): Promise<boolean> {
  const cfg = state.config.evm!
  const [onChain, threshold] = await Promise.all([
    pub.readContract({ address: cfg.minter as Hex, abi: MINTER_ABI, functionName: 'signers' }) as Promise<readonly string[]>,
    pub.readContract({ address: cfg.minter as Hex, abi: MINTER_ABI, functionName: 'threshold' }) as Promise<number>,
  ])
  const theirs = [...onChain].map((a) => a.toLowerCase()).sort()
  const ours = operatorAddresses(state)
  const ok = theirs.join(',') === ours.join(',') && Number(threshold) === state.config.k
  if (!ok) log(`relay: minter signers ${theirs.join(',')} threshold ${threshold} differ from operators ${ours.join(',')} k ${state.config.k}; not relaying`)
  return ok
}

/** True when the chain already holds the action's outcome, so there is nothing left to relay. */
async function alreadyDone(state: State, pub: ReturnType<typeof publicClient>, action: EvmActionRec): Promise<boolean> {
  const minter = state.config.evm!.minter as Hex
  if (action.kind === 'mint') {
    const m = action.data as { srcTx: string }
    return (await pub.readContract({ address: minter, abi: MINTER_ABI, functionName: 'minted', args: [m.srcTx as Hex] })) as boolean
  }
  if (action.kind === 'update') {
    // The minter takes nonces in order, so a nonce at or below its own has been applied (or never can be).
    const u = action.data as { tokenId: string; nonce: string }
    return ((await pub.readContract({ address: minter, abi: MINTER_ABI, functionName: 'metaNonce', args: [u.tokenId as Hex] })) as bigint) >= BigInt(u.nonce)
  }
  const l = action.data as { tokenId: string }
  const addr = (await pub.readContract({ address: minter, abi: MINTER_ABI, functionName: 'tokens', args: [l.tokenId as Hex] })) as string
  return !!addr && !/^0x0+$/.test(addr)
}

/**
 * Relays every pending action this node is the designated relayer for and
 * holds k attestations for. Before spending gas: skip what the chain already
 * shows done, and simulate the call so a revert is recorded, not broadcast.
 */
/**
 * A pending inbound mint that an operator has paused, for its token or for the whole bridge: nobody relays it until the
 * resume. A return mint (a refused release given back to its burner) is a user leaving, and is never held.
 */
export function heldByOperator(state: State, action: EvmActionRec): boolean {
  if (action.kind !== 'mint' || action.reason.kind !== 'mint') return false
  const t = state.transfers[action.reason.transferId]
  if (!t || t.dir !== 'in') return false
  const token = state.tokens[t.sym]
  return !!token && isHeld(state, token)
}

export async function relayReady(state: State, keys: NodeKeys, cache: AttCache, lcl: number): Promise<string[]> {
  const notes: string[] = []
  const cfg = state.config.evm
  if (!cfg) return notes
  const myIndex = myOperatorIndex(state, keys)
  if (myIndex < 0) return notes
  const n = operatorAddresses(state).length
  const pub = publicClient(cfg, RELAY_TIMEOUT_MS)
  let setOk: boolean | null = null
  for (const action of Object.values(state.evmActions)) {
    if (action.status !== 'pending' || action.relayer % n !== myIndex) continue
    if (heldByOperator(state, action)) continue
    const entry = cache[action.id]
    if (!entry) continue
    const signers = Object.keys(entry.sigs).sort()
    if (signers.length < state.config.k) continue
    if (entry.submitted?.done) continue
    if (entry.submitted && lcl - entry.submitted.lcl < (entry.submitted.kind === 'paused' || entry.submitted.kind === 'transient' || entry.submitted.kind === 'bad-signature' ? SOON_ROUNDS : RERELAY_AFTER_ROUNDS)) continue
    const sigs = signers.slice(0, state.config.k).map((s) => entry.sigs[s])
    try {
      if (setOk === null) setOk = await signerSetMatches(state, pub)
      if (!setOk) break
      if (await alreadyDone(state, pub, action)) {
        entry.submitted = { lcl, done: true }
        notes.push(`${action.id} ${action.kind} already on chain; not relaying`)
        continue
      }
      const { client, account } = walletClient(cfg, keys.evm.privateKey as Hex, RELAY_TIMEOUT_MS)
      const t = typed(state, action)
      const call = { address: cfg.minter as Hex, abi: MINTER_ABI, functionName: RELAY_FUNCTION[action.kind], args: [t.message as any, sigs] as any, gas: BigInt(cfg.gasLimit), account, chain: client.chain }
      // eth_call first: a revert costs nothing and its reason is worth more than a hash nobody reads.
      await pub.simulateContract(call as any)
      const gasPrice = await pub.getGasPrice()
      const hash = await client.writeContract({ ...call, gasPrice, type: 'legacy' } as any)
      entry.submitted = { lcl, hash }
      notes.push(`${action.id} ${action.kind} relayed ${hash.slice(0, 10)}`)
    } catch (e) {
      let kind = classifyRelayError(e, action.kind)
      // The minter says it is done: take its word only when a read agrees.
      if (kind === 'already-done' && !(await alreadyDone(state, pub, action).catch(() => false))) kind = 'fatal'
      if (kind === 'already-done') {
        entry.submitted = { lcl, done: true, kind }
        notes.push(`${action.id} ${action.kind} already on chain; not relaying`)
        continue
      }
      const name = revertName(e)
      const msg = `${name ? `${name}: ` : ''}${(e as any).shortMessage ?? (e as Error).message ?? String(e)}`.replace(/\s+/g, ' ').slice(0, 160)
      // The minter refused a signature in the set. Keep only this node's own and let the peers' come back through ingest (they re-send every round, and each is checked again), so one bad entry cannot stay in every cache for good.
      if (kind === 'bad-signature') {
        const mine = keys.evm.address.toLowerCase()
        for (const signer of Object.keys(entry.sigs)) if (signer !== mine) delete entry.sigs[signer]
      }
      entry.submitted = { lcl, error: msg, kind }
      notes.push(`${action.id} ${action.kind} relay error (${kind}): ${msg}`)
    }
  }
  return notes
}

export function attestationCounts(cache: AttCache): Record<string, { sigs: number; submitted?: AttCache[string]['submitted'] }> {
  const out: Record<string, { sigs: number; submitted?: AttCache[string]['submitted'] }> = {}
  for (const [id, e] of Object.entries(cache)) out[id] = { sigs: Object.keys(e.sigs).length, submitted: e.submitted }
  return out
}
