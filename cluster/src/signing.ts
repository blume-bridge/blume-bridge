import fs from 'node:fs'
import { decodeAccountID } from 'ripple-address-codec'
import { encodeForMultisigning } from 'ripple-binary-codec'
import { verify as verifySig } from 'ripple-keypairs'
import { decode } from 'xrpl'
import { submitMultisigned } from './feed/xrpl'
import { xrplWallet, type NodeKeys } from './keys'
import { log } from './log'
import type { ActionRec, OperatorKeys, SigMessage, SignerEntry, State } from './types'

/**
 * Node-local half of multisigning. Nothing here touches consensus state:
 * signatures live in `../sigs.json`, submission is a side effect, and the
 * outcome returns through the ledger feed as an agreed event.
 */
const SIGS_PATH = '../sigs.json'
const SUBMIT_TIMEOUT_MS = 2500
/** Rounds to wait before submitting the same action again. */
const RESUBMIT_AFTER_ROUNDS = 20

interface SigCache {
  [actionId: string]: {
    signers: Record<string, SignerEntry>
    submitted?: { lcl: number; result?: string; hash?: string; message?: string }
  }
}

export function loadSigs(): SigCache {
  try {
    return JSON.parse(fs.readFileSync(SIGS_PATH, 'utf8')) as SigCache
  } catch {
    return {}
  }
}

function saveSigs(cache: SigCache, state: State): void {
  // Forget actions that are no longer pending.
  for (const id of Object.keys(cache)) if (state.actions[id]?.status !== 'pending') delete cache[id]
  try {
    fs.writeFileSync(SIGS_PATH, JSON.stringify(cache))
  } catch (e) {
    log(`sigs: cannot save: ${(e as Error).message}`)
  }
}

function signerAccounts(state: State): Set<string> {
  return new Set(Object.values(state.operators).map((o) => o.xrplAddress))
}

/** Operators by XRPL address, from consensus state: the only key a signature may be checked against. */
function operatorsByAddress(state: State): Map<string, OperatorKeys> {
  return new Map(Object.values(state.operators).map((o) => [o.xrplAddress, o]))
}

/**
 * Signs every pending action this node is a signer for. Idempotent; returns
 * what to broadcast. An outer Batch (xrpl.batch) goes through here unchanged:
 * RawTransactions is a signing field, so the operators' signatures cover the
 * inners, and BatchSigners is only for batches whose inners come from other
 * accounts (ours are all from the outer's own account; listing it there is
 * temBAD_SIGNER). The inners themselves are never signed by anyone.
 */
export function mySignatures(state: State, keys: NodeKeys, cache: SigCache): SigMessage[] {
  const out: SigMessage[] = []
  if (!signerAccounts(state).has(keys.xrpl.address)) return out
  const wallet = xrplWallet(keys)
  for (const action of Object.values(state.actions)) {
    if (action.status !== 'pending') continue
    const entry = (cache[action.id] ??= { signers: {} })
    let mine: SignerEntry | undefined = entry.signers[keys.xrpl.address]
    if (!mine) {
      try {
        const signed = wallet.sign({ ...(action.tx as any), SigningPubKey: '' }, true)
        const decoded = decode(signed.tx_blob) as { Signers?: SignerEntry[] }
        const first = decoded.Signers?.[0]
        if (!first) throw new Error('no Signer in blob')
        mine = first
        entry.signers[keys.xrpl.address] = first
      } catch (e) {
        log(`sign ${action.id}: ${(e as Error).message}`)
        continue
      }
    }
    out.push({ a: action.id, s: mine })
  }
  return out
}

/**
 * Takes in signatures other nodes broadcast, verifying each against the
 * action's transaction. The signing key must be the one the operator set
 * agreed for that account: a signature that verifies under some other key
 * would sit in every peer's cache as that operator's and make the assembled
 * transaction fail on the ledger.
 */
export function ingestSignatures(state: State, cache: SigCache, received: { node: string; sig: SigMessage }[]): number {
  const operators = operatorsByAddress(state)
  let added = 0
  for (const { sig } of received) {
    const action = state.actions[sig.a]
    if (!action || action.status !== 'pending') continue
    const account = sig.s.Signer.Account
    const operator = operators.get(account)
    if (!operator) continue
    const entry = (cache[action.id] ??= { signers: {} })
    if (entry.signers[account]) continue
    try {
      if (String(sig.s.Signer.SigningPubKey).toUpperCase() !== operator.xrplPublicKey.toUpperCase()) throw new Error('signing key is not the operator key')
      const signingData = encodeForMultisigning({ ...(action.tx as any), SigningPubKey: '' }, account)
      if (!verifySig(signingData, sig.s.Signer.TxnSignature, sig.s.Signer.SigningPubKey)) throw new Error('bad signature')
    } catch (e) {
      log(`ingest ${action.id} from ${account}: ${(e as Error).message}`)
      continue
    }
    entry.signers[account] = sig.s
    added++
  }
  return added
}

/** Builds the multisigned transaction for an action from the signatures held. The ledger wants Signers in ascending numeric AccountID order, which base58 order is not. */
export function assemble(action: ActionRec, entry: SigCache[string], k: number): Record<string, unknown> | null {
  const entries = Object.values(entry.signers)
  if (entries.length < k) return null
  const Signers = entries
    .slice(0, k)
    .sort((a, b) => Buffer.compare(decodeAccountID(a.Signer.Account), decodeAccountID(b.Signer.Account)))
    .map((s) => ({ Signer: s.Signer }))
  return { ...(action.tx as any), SigningPubKey: '', Signers }
}

/** Submits every pending action that has k signatures. Every node does this; duplicates come back as tefPAST_SEQ/tefALREADY and are harmless. */
export async function submitReady(state: State, cache: SigCache, lcl: number): Promise<string[]> {
  const notes: string[] = []
  for (const action of Object.values(state.actions)) {
    if (action.status !== 'pending') continue
    const entry = cache[action.id]
    if (!entry) continue
    const tx = assemble(action, entry, state.config.k)
    if (!tx) continue
    if (entry.submitted && lcl - entry.submitted.lcl < RESUBMIT_AFTER_ROUNDS) continue
    try {
      const res = await submitMultisigned(state.config.xrpl, tx, SUBMIT_TIMEOUT_MS)
      entry.submitted = { lcl, result: res.result, hash: res.hash, message: res.message }
      notes.push(`${action.id} ${action.kind} seq ${action.sequence}: ${res.result} ${res.hash?.slice(0, 8) ?? ''}`)
    } catch (e) {
      entry.submitted = { lcl, result: 'error', message: (e as Error).message }
      notes.push(`${action.id}: submit error ${(e as Error).message}`)
    }
  }
  return notes
}

/** Signature counts per action, for read-only views. */
export function signatureCounts(cache: SigCache): Record<string, { sigs: number; submitted?: SigCache[string]['submitted'] }> {
  const out: Record<string, { sigs: number; submitted?: SigCache[string]['submitted'] }> = {}
  for (const [id, entry] of Object.entries(cache)) out[id] = { sigs: Object.keys(entry.signers).length, submitted: entry.submitted }
  return out
}

export function persistSigs(cache: SigCache, state: State): void {
  saveSigs(cache, state)
}
