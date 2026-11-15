import fs from 'node:fs'
import path from 'node:path'
import { decodeEventLog, getAbiItem, toEventSelector, type Hex, type PublicClient } from 'viem'
import { MINTER_ABI, TOKEN_ABI, publicClient, tokenIdOf } from '../evm'
import { log } from '../log'
import type { EvmConfig, EvmEvent, EvmView, State } from '../types'
import { evmCoverage } from './coverage'
import { rotated } from './node'
import { EVM_VIEW_BYTES, cutWindow, eventBytes } from './window'

/**
 * Reads XRPL EVM over public JSON-RPC in fixed block windows a safe distance
 * behind the head, the same way the XRPL feed reads ledgers, and votes the
 * result. Logs from the minter (Minted, Listed, Updated) and from every listed
 * token (Burn) are the only event inputs; the minter's pause switch and exit
 * fee are read, not inferred from events, at the block the window ends on.
 */
const CACHE_DIR = '/tmp'
const HEAD_CACHE = 'bridge-evm-head.json'
const LOG_CACHE = 'bridge-evm-logs.json'
const SPAN_BLOCKS = 500
/** The four events the cluster reads. Filtering by topic keeps a token's Transfer and Approval logs off the wire. */
const TOPICS: Hex[] = [
  toEventSelector(getAbiItem({ abi: MINTER_ABI, name: 'Minted' })),
  toEventSelector(getAbiItem({ abi: MINTER_ABI, name: 'Listed' })),
  toEventSelector(getAbiItem({ abi: MINTER_ABI, name: 'Updated' })),
  toEventSelector(getAbiItem({ abi: TOKEN_ABI, name: 'Burn' })),
]

/**
 * How many blocks the next window may cover. Normally `windowBlocks`; a cursor a whole span or more behind (an outage:
 * 2026-11-04, ~109k blocks, which at 10 blocks a round is a day and a half) takes the span as one window, the same
 * single eth_getLogs the span cache already makes, so it catches up in about an hour. The window's events are still
 * capped by cutWindow. Nodes whose cached heads straddle the threshold propose different windows for a round, which
 * costs that round and nothing else: two different views cannot both reach k when k is more than half of n.
 */
export function evmWindowBlocks(cfg: Pick<EvmConfig, 'windowBlocks' | 'confirmations'>, from: number, head: number): number {
  return head - cfg.confirmations - from >= SPAN_BLOCKS ? Math.max(cfg.windowBlocks, SPAN_BLOCKS) : cfg.windowBlocks
}

/** What a test swaps out: the client every read goes through, and where the node-local scratch files live. */
export interface EvmViewDeps {
  client?: PublicClient
  cacheDir?: string
}

async function headBlockCached(cfg: EvmConfig, client: PublicClient, dir: string): Promise<number> {
  const file = path.join(dir, HEAD_CACHE)
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as { block: number; at: number }
    if (Date.now() - c.at < cfg.pollMs) return c.block
  } catch {
    /* no cache */
  }
  const block = Number(await client.getBlockNumber())
  try {
    fs.writeFileSync(file, JSON.stringify({ block, at: Date.now() }))
  } catch {
    /* node-local only */
  }
  return block
}

interface LogCache {
  key: string
  from: number
  to: number
  events: EvmEvent[]
}

function decodeLogs(raw: any[], minter: string, tokenAddresses: Set<string>): EvmEvent[] {
  const out: EvmEvent[] = []
  for (const l of raw) {
    const address = String(l.address).toLowerCase()
    const block = Number(l.blockNumber)
    const tx = String(l.transactionHash).toLowerCase()
    const logIndex = Number(l.logIndex)
    try {
      if (address === minter.toLowerCase()) {
        const d = decodeEventLog({ abi: MINTER_ABI, data: l.data, topics: l.topics })
        if (d.eventName === 'Minted') out.push({ kind: 'mint', tx, block, logIndex, tokenId: d.args.tokenId.toLowerCase(), to: d.args.to.toLowerCase(), amountWei: d.args.amount.toString(), srcTx: d.args.srcTx.toLowerCase() })
        else if (d.eventName === 'Listed') out.push({ kind: 'listed', tx, block, logIndex, tokenId: d.args.tokenId.toLowerCase(), token: d.args.token.toLowerCase(), symbol: d.args.symbol, dailyCapWei: d.args.dailyCap.toString() })
        // The new name, symbol and logo are what the state already holds (it asked for them); the cap and the nonce are what the minter now has.
        else if (d.eventName === 'Updated') out.push({ kind: 'updated', tx, block, logIndex, tokenId: d.args.tokenId.toLowerCase(), token: d.args.token.toLowerCase(), dailyCapWei: d.args.dailyCap.toString(), nonce: d.args.nonce.toString() })
      } else if (tokenAddresses.has(address)) {
        const d = decodeEventLog({ abi: TOKEN_ABI, data: l.data, topics: l.topics })
        if (d.eventName === 'Burn') out.push({ kind: 'burn', tx, block, logIndex, token: address, from: d.args.from.toLowerCase(), amountWei: d.args.amount.toString(), rAddress: d.args.rAddress, nonce: d.args.nonce.toString() })
      }
    } catch {
      /* a log we do not decode (Transfer, Approval) */
    }
  }
  return out
}

function getLogs(client: PublicClient, addresses: string[], from: number, to: number): Promise<any[]> {
  return client.request({ method: 'eth_getLogs', params: [{ address: addresses as Hex[], topics: [TOPICS], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] }) as Promise<any[]>
}

/**
 * The logs for [from, spanTo] and, right after them, the head of the node that
 * answered. Each endpoint is tried whole, in order, and its logs are never
 * paired with another endpoint's head: a public RPC that is behind answers
 * eth_getLogs past its own head with silence, not an error, so how much of the
 * span a read covers is only known from the head of the node that gave it. A
 * transport that failed over between the two calls could vouch for a lagging
 * node's partial answer with a healthy node's head and cache the span with
 * events missing.
 */
export async function logsAndHead(clients: PublicClient[], addresses: string[], from: number, spanTo: number, to: number): Promise<{ raw: any[]; readTo: number; headNow: number }> {
  let failure: unknown
  for (const client of rotated(clients, 'evm')) {
    try {
      let readTo = spanTo
      let raw: any[]
      try {
        raw = await getLogs(client, addresses, from, spanTo)
      } catch (e) {
        // A span the RPC will not answer whole (too many logs or blocks for one call). The window alone is small.
        log(`evm logs ${from}-${spanTo}: ${(e as Error).message.slice(0, 80)}; reading the window alone`)
        readTo = to
        raw = await getLogs(client, addresses, from, to)
      }
      return { raw, readTo, headNow: Number(await client.getBlockNumber()) }
    } catch (e) {
      failure = e
    }
  }
  throw failure ?? new Error('no endpoint to read logs from')
}

/**
 * Logs for [from, to], served from the node-local span cache when it covers
 * them. Returns `coveredTo`, the last block (at most `to`) the read is good
 * for (see logsAndHead).
 */
async function logsCached(cfg: EvmConfig, clients: PublicClient[], dir: string, addresses: string[], from: number, to: number, head: number): Promise<{ events: EvmEvent[]; coveredTo: number }> {
  const file = path.join(dir, LOG_CACHE)
  const key = [...addresses].sort().join(',')
  let cache: LogCache | null = null
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8')) as LogCache
  } catch {
    /* none */
  }
  if (cache && cache.key === key && cache.from <= from && cache.to >= to) return { events: cache.events.filter((e) => e.block >= from && e.block <= to), coveredTo: to }
  const spanTo = Math.max(to, Math.min(head - cfg.confirmations, from + SPAN_BLOCKS - 1))
  const { raw, readTo, headNow } = await logsAndHead(clients, addresses, from, spanTo, to)
  const coveredTo = evmCoverage(readTo, headNow, cfg.confirmations)
  const events = decodeLogs(raw, cfg.minter, new Set(addresses.filter((a) => a.toLowerCase() !== cfg.minter.toLowerCase()).map((a) => a.toLowerCase())))
  if (coveredTo < from) {
    log(`evm logs ${from}-${readTo}: the answering node is at ${headNow}, nothing covered`)
    return { events: [], coveredTo: from - 1 }
  }
  try {
    fs.writeFileSync(file, JSON.stringify({ key, from, to: coveredTo, events: events.filter((e) => e.block <= coveredTo) } satisfies LogCache))
  } catch {
    /* node-local only */
  }
  const end = Math.min(to, coveredTo)
  return { events: events.filter((e) => e.block >= from && e.block <= end), coveredTo: end }
}

/**
 * This node's proposal for the next EVM window, or null when the chain has
 * not closed it yet. The window ends early, on a whole block, when it holds
 * more than maxEventsPerView events; it never leaves an event out (see cutWindow).
 */
export async function evmView(state: State, timeoutMs: number, deps: EvmViewDeps = {}): Promise<EvmView | null> {
  const cfg = state.config.evm
  if (!cfg || !state.cursor.evm) return null
  const dir = deps.cacheDir ?? CACHE_DIR
  // Reads that do not care which node answers go through one client over every endpoint. No retry round: the view has a budget of about a second, and the next round asks again.
  const client = deps.client ?? publicClient({ ...cfg, rpc: rotated(cfg.rpc, 'evm') }, timeoutMs, 0)
  const from = state.cursor.evm.block
  const head = await headBlockCached(cfg, client, dir)
  const full = from + evmWindowBlocks(cfg, from, head)
  if (head - cfg.confirmations < full) return null
  const addresses = [cfg.minter, ...Object.values(state.tokens).map((t) => t.evmAddress).filter((a): a is string => !!a)]
  const logClients = deps.client ? [deps.client] : cfg.rpc.map((url) => publicClient({ ...cfg, rpc: [url] }, timeoutMs, 0))
  const read = await logsCached(cfg, logClients, dir, addresses, from + 1, full, head)
  if (read.coveredTo <= from) return null
  // The first `skip` events are the ones earlier views of this same block already carried (the cursor has not moved past it).
  const skip = state.cursor.evm.skip ?? 0
  const all = read.events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  const sorted = all.slice(skip)
  const { to, events, cut, partial } = cutWindow(sorted, { from, to: Math.min(full, read.coveredTo), cap: cfg.maxEventsPerView, bytes: EVM_VIEW_BYTES, pos: (e) => e.block, size: eventBytes })
  if (partial) log(`evm: block ${from + 1} holds ${all.length - skip} unapplied events (${all.length} in the window); carrying ${events.length} of them (cap ${cfg.maxEventsPerView}, ${EVM_VIEW_BYTES} bytes)`)
  else if (to !== full) log(`evm: window ${from}→${to} ends early (full window ${full}, ${sorted.length} events, cap ${cfg.maxEventsPerView}${cut ? '' : ', history read short'})`)
  const pinned = await pinnedReads(state, cfg, client, to)
  const view: EvmView = { src: 'evm', from, to, events, listings: pinned.listings, paused: pinned.paused, burnFee: pinned.burnFee }
  if (skip > 0) view.skip = skip
  return view
}

/**
 * What the view reads from the minter at block `to` rather than from events:
 * its pause switch and exit fee, and, for tokens it already lists that the
 * state has no address for (a fresh state, or a listing relayed before
 * genesis), the address, the daily cap and the metadata nonce (an update must
 * carry the next one).
 *
 * The switches and each pending token's address and nonce share one Multicall3
 * round trip, so the pause switch costs no trip of its own while listings are
 * adopted; the caps need the addresses, so they are the second and last. A
 * node whose endpoint cannot answer at `to` throws and proposes nothing this
 * round, on purpose: a view missing a field would hash differently from every
 * other node's and split the vote.
 */
async function pinnedReads(state: State, cfg: EvmConfig, client: PublicClient, to: number): Promise<{ paused: boolean; burnFee: string; listings: EvmView['listings'] }> {
  const blockNumber = BigInt(to)
  const minter = cfg.minter as Hex
  const ids = Object.values(state.tokens)
    .filter((t) => !t.evmAddress && t.status === 'listed')
    .map((t) => tokenIdOf(t))
  const call = (functionName: string, args?: readonly unknown[]) => ({ address: minter, abi: MINTER_ABI, functionName, args })
  let first: unknown[]
  try {
    first = (await client.multicall({ contracts: [call('paused'), call('burnFee'), ...ids.map((id) => call('tokens', [id])), ...ids.map((id) => call('metaNonce', [id]))] as any, blockNumber, allowFailure: false })) as unknown[]
  } catch (e) {
    throw new Error(`minter ${minter} at block ${to}: ${(e as any).shortMessage ?? (e as Error).message.split('\n')[0]} (is it a v3 minter?)`)
  }
  const addrs = first.slice(2, 2 + ids.length) as string[]
  const nonces = first.slice(2 + ids.length) as bigint[]
  const listings: EvmView['listings'] = {}
  const found = ids.map((id, i) => ({ id, addr: String(addrs[i] ?? ''), nonce: nonces[i] })).filter(({ addr }) => addr && !/^0x0+$/.test(addr))
  if (found.length) {
    const caps = (await client.multicall({ contracts: found.map(({ addr }) => call('caps', [addr])) as any, blockNumber, allowFailure: false })) as unknown as readonly (readonly [bigint, bigint, bigint])[]
    found.forEach(({ id, addr, nonce }, i) => {
      listings[id.toLowerCase()] = { token: addr.toLowerCase(), dailyCapWei: caps[i][0].toString(), metaNonce: nonce.toString() }
    })
  }
  return { paused: first[0] as boolean, burnFee: (first[1] as bigint).toString(), listings }
}

/** ERC-20 balances of an EVM address for every listed token, for read-only views. */
export async function readEvmBalances(cfg: EvmConfig, tokens: { sym: string; evmAddress?: string }[], address: string, timeoutMs: number): Promise<Record<string, string>> {
  const client = publicClient(cfg, timeoutMs)
  const out: Record<string, string> = {}
  for (const t of tokens) {
    if (!t.evmAddress) continue
    try {
      const wei = (await client.readContract({ address: t.evmAddress as Hex, abi: TOKEN_ABI, functionName: 'balanceOf', args: [address as Hex] })) as bigint
      out[t.sym] = wei.toString()
    } catch (e) {
      log(`evm balance ${t.sym}: ${(e as Error).message.slice(0, 80)}`)
    }
  }
  return out
}
