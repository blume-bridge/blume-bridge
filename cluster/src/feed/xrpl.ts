import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { isValidClassicAddress } from 'ripple-address-codec'
import * as dec from '../dec'
import { BLACKHOLE_ADDRESSES, RATE_ONE, proposalIssuer } from '../listing'
import { log } from '../log'
import type { AccountSnap, Amount, IssuerFlags, LedgerEvent, State, TokenRec, XrplConfig, XrplOutgoingEvent, XrplPaymentEvent, XrplView } from '../types'
import { EXTRA_CA_CERTS } from './ca'
import { cmpStr } from '../canon'
import { xrplCoverage } from './coverage'
import { ledgerOrder } from '../machine'
import { rotated } from './node'
import { XRPL_VIEW_BYTES, cutWindow, eventBytes } from './window'

/**
 * Reads the XRP Ledger over public JSON-RPC. Every node does this on its own
 * and the results are non-deterministic (different servers, different
 * moments), which is why they go through the vote before touching state.
 * Windows are fixed size and only proposed once fully validated, so honest
 * nodes with the same history propose byte-identical views.
 */

// lsf* account flags
const LSF_REQUIRE_DEST_TAG = 0x00020000
const LSF_REQUIRE_AUTH = 0x00040000
const LSF_DEPOSIT_AUTH = 0x01000000
const LSF_DISABLE_MASTER = 0x00100000
const LSF_NO_FREEZE = 0x00200000
const LSF_GLOBAL_FREEZE = 0x00400000
const LSF_DEFAULT_RIPPLE = 0x00800000
const LSF_ALLOW_CLAWBACK = 0x80000000

/**
 * Trust store: the OS bundle when the image has one (the HotPocket image's
 * Ubuntu 20.04 store knows roots that its Node 20.4 bundle does not, e.g. the
 * Sectigo R46 root behind s.altnet.rippletest.net), plus Node's roots, plus
 * any intermediates a server forgets to send.
 */
const OS_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'
const CA: string[] = [...(fs.existsSync(OS_BUNDLE) ? [fs.readFileSync(OS_BUNDLE, 'utf8')] : []), ...tls.rootCertificates, ...EXTRA_CA_CERTS]

function postJson(url: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    // https for the public servers; http only for the operator's own server on a private address, which has no certificate to check.
    const plain = u.protocol === 'http:'
    const req = (plain ? http : https).request(
      { method: 'POST', hostname: u.hostname, port: u.port || (plain ? 80 : 443), path: u.pathname || '/', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'blume-bridge-cluster/0.1' }, ...(plain ? {} : { ca: CA }), timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
    req.on('error', reject)
    req.end(body)
  })
}

export async function rpc<T = any>(urls: string[], method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const errors: string[] = []
  for (const url of rotated(urls, 'xrpl')) {
    try {
      const res = await postJson(url, JSON.stringify({ method, params: [{ api_version: 2, ...params }] }), timeoutMs)
      let body: { result?: T & { status?: string; error?: string; error_message?: string } }
      try {
        body = JSON.parse(res.text)
      } catch {
        throw new Error(`HTTP ${res.status}, not JSON: ${res.text.slice(0, 60).replace(/\s+/g, ' ')}`)
      }
      if (!body.result) throw new Error(`HTTP ${res.status}, empty result`)
      if (body.result.status === 'error' || body.result.error) throw new Error(`${body.result.error_message ?? body.result.error}`)
      return body.result
    } catch (e) {
      const err = e as Error & { code?: string }
      errors.push(`${new URL(url).host}: ${err.code ?? ''} ${err.message}`.trim())
    }
  }
  throw new Error(`${method} failed on every RPC (${errors.join(' | ')})`)
}

/** The validated ledger, re-read at most every `pollMs` per node. Node-local cache so three nodes on one box do not hammer a public server every round. */
const LEDGER_CACHE = '/tmp/bridge-validated-ledger.json'

export async function validatedLedgerCached(cfg: XrplConfig, timeoutMs: number): Promise<number> {
  try {
    const c = JSON.parse(fs.readFileSync(LEDGER_CACHE, 'utf8')) as { ledger: number; at: number }
    if (Date.now() - c.at < cfg.pollMs) return c.ledger
  } catch {
    /* no cache yet */
  }
  const ledger = await validatedLedger(cfg, timeoutMs)
  try {
    fs.writeFileSync(LEDGER_CACHE, JSON.stringify({ ledger, at: Date.now() }))
  } catch {
    /* node-local only */
  }
  return ledger
}

export async function validatedLedger(cfg: XrplConfig, timeoutMs: number): Promise<number> {
  const r = await rpc<{ ledger_index: number }>(cfg.rpc, 'ledger', { ledger_index: 'validated' }, timeoutMs)
  return Number(r.ledger_index)
}

function decodeMemo(tx: any): string | null {
  const memo = tx?.Memos?.[0]?.Memo?.MemoData
  if (typeof memo !== 'string') return null
  try {
    return Buffer.from(memo, 'hex').toString('utf8')
  } catch {
    return null
  }
}

/**
 * Null for any amount we cannot represent, rather than a throw. An MPT is one;
 * so is a value dec refuses, which includes the legacy `delivered_amount:
 * "unavailable"` a partial payment can still carry. A throw here would escape
 * the whole window read, so every node would fail the same ledger forever and
 * the cursor would never pass it — a caller dropping one payment is the far
 * cheaper failure.
 */
function toAmount(delivered: unknown): Amount | null {
  try {
    if (typeof delivered === 'string') return { currency: 'XRP', value: dec.fromDrops(delivered) }
    if (delivered && typeof delivered === 'object') {
      const d = delivered as { currency?: string; issuer?: string; value?: string; mpt_issuance_id?: string }
      if (d.mpt_issuance_id) return null
      if (d.currency && d.issuer && d.value) return { currency: d.currency, issuer: d.issuer, value: dec.format(dec.parse(d.value)) }
    }
  } catch {
    /* not an amount this bridge can carry */
  }
  return null
}

const PAGE = 200
const MAX_PAGES = 10

/**
 * One validated account_tx entry seen from `account`'s side: an outgoing
 * event when the account sent it, a payment event when a successful Payment
 * reached it, otherwise no event but still the ledger it sat in (a failed or
 * foreign transaction still proves the ledger was read). Null when the entry
 * is unusable. Pure, so the shape a Batch leaves on the ledger can be tested
 * from a captured response.
 *
 * A Batch's inner transactions come back as ordinary entries (their own hash
 * and meta, Fee "0", tfInnerBatchTxn set) with meta.ParentBatchID naming the
 * outer, so they parse like any payment and only carry that hash along. The
 * outer itself has no Destination or Amount; it shows as an outgoing event
 * whose `inner` counts what it carried.
 *
 * An inner our own account sent is emitted whatever its result, exactly like
 * any other outgoing, because a tfIndependent batch records a failing inner
 * with its own tec while the outer still reads tesSUCCESS. The feed's job is
 * to put those inner results in the view; settling a batch action by them
 * (ActionRec.inner) is the reducer's, and applyOutgoing does not do it yet —
 * it still matches on the outer's sequence and settles on the outer's result,
 * which would call a batch of failed inners validated. Harmless only while
 * nothing queues an xrpl.batch action.
 */
export function parseAccountTxEntry(entry: any, account: string): { ledger: number; event: LedgerEvent | null } | null {
  const tx = entry?.tx_json ?? entry?.tx
  const meta = entry?.meta
  const hash = entry?.hash ?? tx?.hash
  if (!tx || !meta || !hash || entry.validated === false) return null
  const ledger = Number(entry.ledger_index ?? tx.ledger_index)
  // An empty ParentBatchID would mark an ordinary transaction as inner, so only a real hash counts. (canon() drops undefined, so the conditional spread is for the reader, not the vote.)
  const batch = typeof meta.ParentBatchID === 'string' && meta.ParentBatchID ? { batch: meta.ParentBatchID.toUpperCase() } : {}
  if (tx.Account === account) {
    // What we asked the ledger to do, so the reducer can match the event to its action, not just to a sequence number. (api_version 2 reports a Payment's Amount as DeliverMax.)
    const requested = toAmount(tx.DeliverMax ?? tx.Amount)
    const event: XrplOutgoingEvent = {
      kind: 'outgoing',
      tx: String(hash).toUpperCase(),
      ledger,
      account,
      type: String(tx.TransactionType),
      result: String(meta.TransactionResult),
      sequence: Number(tx.Sequence),
      ...(typeof tx.Destination === 'string' ? { destination: tx.Destination } : {}),
      ...(requested ? { amount: requested } : {}),
      ...batch,
      ...(tx.TransactionType === 'Batch' && Array.isArray(tx.RawTransactions) ? { inner: tx.RawTransactions.length } : {}),
    }
    return { ledger, event }
  }
  if (tx.TransactionType !== 'Payment' || tx.Destination !== account) return { ledger, event: null }
  if (meta.TransactionResult !== 'tesSUCCESS') return { ledger, event: null }
  const amount = toAmount(meta.delivered_amount ?? meta.DeliveredAmount)
  if (!amount) return { ledger, event: null }
  const event: XrplPaymentEvent = {
    kind: 'payment',
    tx: String(hash).toUpperCase(),
    ledger,
    from: tx.Account,
    to: account,
    amount,
    memo: decodeMemo(tx),
    ...batch,
  }
  return { ledger, event }
}

/**
 * Everything that touched `account` between the ledgers, inclusive: successful
 * payments in (what users do) and every transaction it sent (what the cluster
 * did, whatever the result). `complete` is false when the span had more pages
 * than we read; `lastLedger` is then the ledger of the last transaction read,
 * and every ledger before it is whole, because pages arrive in ledger order.
 * `searchedMax` is the newest ledger the server says it searched (null when
 * it did not say), so a short-history server never passes for a full one.
 */
export async function accountEvents(cfg: XrplConfig, account: string, from: number, to: number, timeoutMs: number): Promise<{ events: LedgerEvent[]; complete: boolean; lastLedger: number; searchedMax: number | null }> {
  const events: LedgerEvent[] = []
  let marker: unknown = undefined
  let complete = false
  let lastLedger = from
  let searchedMax: number | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await rpc<{ transactions: any[]; marker?: unknown; ledger_index_max?: number }>(
      cfg.rpc,
      'account_tx',
      { account, ledger_index_min: from, ledger_index_max: to, forward: true, limit: PAGE, binary: false, ...(marker ? { marker } : {}) },
      timeoutMs,
    )
    const reported = Number(r.ledger_index_max)
    if (Number.isFinite(reported)) searchedMax = searchedMax === null ? reported : Math.min(searchedMax, reported)
    for (const entry of r.transactions ?? []) {
      const parsed = parseAccountTxEntry(entry, account)
      if (!parsed) continue
      if (Number.isFinite(parsed.ledger)) lastLedger = Math.max(lastLedger, parsed.ledger)
      if (parsed.event) events.push(parsed.event)
    }
    marker = r.marker
    if (!marker) {
      complete = true
      break
    }
  }
  return { events, complete, lastLedger, searchedMax }
}

/**
 * Node-local cache of validated payments per account, so a window costs no
 * RPC call when a previous poll already covered it. Validated history never
 * changes, so a cached span is good forever. One read covers up to
 * SPAN_LEDGERS ahead of the window, which turns a catch-up replay from two
 * calls per round into two calls per poll.
 *
 * Returns the events up to `coveredTo`, the last ledger (at most `to`) whose
 * history was read whole. A span busier than MAX_PAGES pages is cut at the
 * last whole ledger rather than read again or given up on; the window then
 * ends there too, and nothing after it is lost.
 */
const TX_CACHE = '/tmp/bridge-txcache.json'
const SPAN_LEDGERS = 200
type TxCache = Record<string, { from: number; to: number; events: LedgerEvent[] }>

export async function accountEventsCached(cfg: XrplConfig, account: string, from: number, to: number, validated: number, timeoutMs: number): Promise<{ events: LedgerEvent[]; coveredTo: number }> {
  let cache: TxCache = {}
  try {
    cache = JSON.parse(fs.readFileSync(TX_CACHE, 'utf8')) as TxCache
  } catch {
    /* no cache yet */
  }
  const hit = cache[account]
  if (hit && hit.from <= from && hit.to >= to) return { events: hit.events.filter((e) => e.ledger >= from && e.ledger <= to), coveredTo: to }
  const spanTo = Math.max(to, Math.min(validated, from + SPAN_LEDGERS - 1))
  const span = await accountEvents(cfg, account, from, spanTo, timeoutMs)
  const coveredTo = xrplCoverage(spanTo, span.complete, span.lastLedger, span.searchedMax)
  if (coveredTo >= from) {
    cache[account] = { from, to: coveredTo, events: span.events.filter((e) => e.ledger <= coveredTo) }
    try {
      fs.writeFileSync(TX_CACHE, JSON.stringify(cache))
    } catch {
      /* node-local only */
    }
  } else log(`account_tx ${account}: nothing covered from ledger ${from} (${span.complete ? `server searched to ${span.searchedMax}` : `more than ${MAX_PAGES * PAGE} transactions in one ledger`})`)
  const end = Math.min(to, coveredTo)
  return { events: span.events.filter((e) => e.ledger >= from && e.ledger <= end), coveredTo: end }
}

/**
 * Sequence and balance of one of our accounts as of exactly `ledgerIndex`.
 * The snapshot is part of the voted view, so a server that lacks the ledger
 * gets no say: every RPC is tried for the pinned read and the round proposes
 * nothing rather than a snapshot from some later ledger.
 */
export async function accountSnap(cfg: XrplConfig, account: string, ledgerIndex: number, timeoutMs: number): Promise<AccountSnap> {
  const r = await rpc<{ account_data: { Sequence: number; Balance: string } }>(cfg.rpc, 'account_info', { account, ledger_index: ledgerIndex }, timeoutMs)
  return { sequence: Number(r.account_data.Sequence), balanceDrops: String(r.account_data.Balance) }
}

/** Submits a transaction carrying k Signers. The ledger feed reports the outcome later; this only returns the engine's first word. */
export async function submitMultisigned(cfg: XrplConfig, txJson: Record<string, unknown>, timeoutMs: number): Promise<{ result: string; hash?: string; message?: string }> {
  const r = await rpc<{ engine_result: string; engine_result_message?: string; tx_json?: { hash?: string } }>(cfg.rpc, 'submit_multisigned', { tx_json: txJson }, timeoutMs)
  return { result: r.engine_result, hash: r.tx_json?.hash, message: r.engine_result_message }
}

/** An account_info answer as an issuer read: its flags, its TransferRate, its Domain, and whether anyone can still sign for it. Pure, for tests. */
export function issuerFromAccountInfo(r: { account_data: { Flags: number; TransferRate?: number; Domain?: string; RegularKey?: string; OwnerCount?: number; signer_lists?: unknown[] }; signer_lists?: unknown[] }): IssuerFlags {
  const a = r.account_data
  const owned = Number(a.OwnerCount)
  const f = Number(a.Flags) >>> 0
  const disableMaster = (f & LSF_DISABLE_MASTER) !== 0
  // api_version 2 puts the signer lists beside account_data; version 1 put them inside.
  const signerLists = r.signer_lists ?? a.signer_lists ?? []
  const rate = Number(a.TransferRate ?? 0)
  let domain: string | undefined
  try {
    domain = a.Domain ? Buffer.from(a.Domain, 'hex').toString('utf8').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 256) || undefined : undefined
  } catch {
    domain = undefined
  }
  return {
    noFreeze: (f & LSF_NO_FREEZE) !== 0,
    globalFreeze: (f & LSF_GLOBAL_FREEZE) !== 0,
    requireAuth: (f & LSF_REQUIRE_AUTH) !== 0,
    clawback: (f & LSF_ALLOW_CLAWBACK) !== 0,
    defaultRipple: (f & LSF_DEFAULT_RIPPLE) !== 0,
    disableMaster,
    transferRate: rate > RATE_ONE ? rate : RATE_ONE,
    blackholed: disableMaster && (!a.RegularKey || BLACKHOLE_ADDRESSES.has(a.RegularKey)) && signerLists.length === 0,
    ...(domain ? { domain } : {}),
    // A Delegate entry (XLS-75) lets another account sign for this one, and like every object the account owns it is counted here.
    ...(Number.isSafeInteger(owned) && owned >= 0 ? { ownerCount: owned } : {}),
  }
}

/**
 * Node-local answers to reads pinned to a ledger (an issuer's account), kept
 * because a pinned ledger's answer never changes. The
 * whole view has a budget of about a second per round (contract.ts), so a
 * window whose reads ran out of time is proposed from here, instantly, the
 * next round. Only definitive answers are kept; a failed read is asked again.
 */
const READS_CACHE = process.env.BRIDGE_READS_CACHE || '/tmp/bridge-ledger-reads.json'
const READS_KEPT = 400
let reads: Record<string, unknown> | null = null

function readsCache(): Record<string, unknown> {
  if (!reads) {
    try {
      reads = JSON.parse(fs.readFileSync(READS_CACHE, 'utf8')) as Record<string, unknown>
    } catch {
      reads = {}
    }
  }
  return reads
}

function remember(key: string, value: unknown): void {
  const c = readsCache()
  c[key] = value
  const keys = Object.keys(c)
  for (const k of keys.slice(0, Math.max(0, keys.length - READS_KEPT))) delete c[k]
  try {
    fs.writeFileSync(READS_CACHE, JSON.stringify(c))
  } catch {
    /* node-local only */
  }
}

/**
 * A read pinned to a ledger, remembered. The view has well under a second to be built (contract.ts), and a window that was
 * cut short needs one more read after the events are known; on a server a few hundred milliseconds away that read finishes
 * after the round's budget has gone, the round proposes nothing, and without a memory the next round starts the same read
 * again and loses the same race, for good. The read is allowed longer than the budget (PINNED_READ_MS) and its answer is
 * kept, so the round after it is instant. Only a finished read is kept: a failure is asked again.
 */
export const PINNED_READ_MS = 2500
export async function pinned<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = readsCache()[key] as T | undefined
  if (hit !== undefined) return hit
  const value = await read()
  remember(key, value)
  return value
}

/**
 * The ledgers whose snapshots are worth fetching now for the windows after this one: only windows the chain has already
 * validated, so a node that is catching up finds each window's snapshot waiting instead of spending a round on it. At the
 * head of the chain there is nothing to fetch ahead.
 */
export function aheadWindows(full: number, validated: number, windowLedgers: number, count = 2): number[] {
  const out: number[] = []
  for (let i = 1; i <= count; i++) if (full + i * windowLedgers <= validated) out.push(full + i * windowLedgers)
  return out
}

/** An account's sequence and balance as of exactly `ledgerIndex`, remembered (see `pinned`). */
export function accountSnapPinned(cfg: XrplConfig, account: string, ledgerIndex: number, timeoutMs: number): Promise<AccountSnap> {
  return pinned(`snap:${account}@${ledgerIndex}`, () => accountSnap(cfg, account, ledgerIndex, Math.max(timeoutMs, PINNED_READ_MS)))
}

/**
 * An issuer's account as of exactly `ledgerIndex`, which every node reads
 * alike. 'missing' when the ledger has no such account; null when the read
 * failed, and then this node proposes nothing different from what it cannot
 * know: there is no fallback to a later ledger, because two nodes falling back
 * at different moments would propose different views.
 */
export async function readIssuer(cfg: XrplConfig, issuer: string, ledgerIndex: number, timeoutMs: number): Promise<IssuerFlags | 'missing' | null> {
  // Named for the shape of the answer: a node that kept a read from before ownerCount must not propose it beside a node that read afresh.
  const key = `issuer2:${issuer}@${ledgerIndex}`
  const hit = readsCache()[key] as IssuerFlags | 'missing' | undefined
  if (hit !== undefined) return hit
  try {
    const r = await rpc<Parameters<typeof issuerFromAccountInfo>[0]>(cfg.rpc, 'account_info', { account: issuer, ledger_index: ledgerIndex, signer_lists: true }, timeoutMs)
    const info = issuerFromAccountInfo(r)
    remember(key, info)
    return info
  } catch (e) {
    const msg = (e as Error).message
    if (/actNotFound|Account not found/i.test(msg)) {
      remember(key, 'missing')
      return 'missing'
    }
    log(`issuer ${issuer} @${ledgerIndex}: ${msg}`)
    return null
  }
}

/** Listed tokens' issuers are read again when a window crosses a multiple of this many ledgers, about 15 minutes. */
export const ISSUER_REFRESH_LEDGERS = 256
/** How many issuers one refresh reads, so a refresh fits the view's budget whatever the number of listings; the rest wait their turn. */
const ISSUERS_PER_REFRESH = 6

/** The issuers whose turn it is at the refresh boundary `to` crossed: a slice of the sorted list that rotates every boundary. */
export function refreshTurn(state: State, to: number): string[] {
  const issuers = [...new Set(Object.values(state.tokens).filter((t) => !t.native).map((t) => t.issuer))].sort(cmpStr)
  const turns = Math.max(1, Math.ceil(issuers.length / ISSUERS_PER_REFRESH))
  const turn = Math.floor(to / ISSUER_REFRESH_LEDGERS) % turns
  return issuers.slice(turn * ISSUERS_PER_REFRESH, (turn + 1) * ISSUERS_PER_REFRESH)
}

/**
 * Those issuers at ledger `to`, or null when any read failed: a partial
 * refresh would be a different view from a whole one on a node whose reads
 * all worked. An issuer whose account is gone is left out.
 */
async function refreshIssuers(state: State, cfg: XrplConfig, to: number, timeoutMs: number): Promise<Record<string, IssuerFlags> | null> {
  const issuers = refreshTurn(state, to)
  const answers = await Promise.all(issuers.map((issuer) => readIssuer(cfg, issuer, to, timeoutMs)))
  const out: Record<string, IssuerFlags> = {}
  for (let i = 0; i < issuers.length; i++) {
    const r = answers[i]
    if (r === null) return null
    if (r !== 'missing') out[issuers[i]] = r
  }
  return out
}

/**
 * This node's proposal for the next window, or null when the ledger has not
 * closed it yet. The window ends early, on a whole ledger, when it holds more
 * than maxEventsPerView events or more history than one read returns; it
 * never leaves an event out (see cutWindow).
 */
export async function xrplView(state: State, timeoutMs: number): Promise<XrplView | null> {
  const cfg = state.config.xrpl
  const from = state.cursor.xrpl.ledger
  const full = from + cfg.windowLedgers
  const validated = await validatedLedgerCached(cfg, timeoutMs)
  if (validated < full) return null
  // Catching up: a window's snapshot is its own read, and on a server a few hundred milliseconds away that read outlasts the view's budget, so
  // each window would cost two rounds (one to start the read, one to find it cached). The next windows' reads start now, in the background.
  for (const ahead of aheadWindows(full, validated, cfg.windowLedgers)) for (const account of [cfg.lockAccount, cfg.fundingAccount]) void accountSnapPinned(cfg, account, ahead, timeoutMs).catch(() => undefined)
  const [lock, funding, lockSnap, fundingSnap] = await Promise.all([
    accountEventsCached(cfg, cfg.lockAccount, from + 1, full, validated, timeoutMs),
    accountEventsCached(cfg, cfg.fundingAccount, from + 1, full, validated, timeoutMs),
    accountSnapPinned(cfg, cfg.lockAccount, full, timeoutMs),
    accountSnapPinned(cfg, cfg.fundingAccount, full, timeoutMs),
  ])
  const covered = Math.min(lock.coveredTo, funding.coveredTo)
  if (covered <= from) return null
  // In the order the machine applies a ledger in, so a flooded ledger worked through a view at a time applies as the whole would have.
  // The first `skip` events are the ones earlier views of this same ledger already carried (the cursor has not moved past it).
  const skip = state.cursor.xrpl.skip ?? 0
  const all = [...lock.events, ...funding.events].filter((e) => e.ledger <= covered).sort(ledgerOrder(state.config))
  const sorted = all.slice(skip)
  const { to, events, cut, partial } = cutWindow(sorted, { from, to: covered, cap: cfg.maxEventsPerView, bytes: XRPL_VIEW_BYTES, pos: (e) => e.ledger, size: eventBytes })
  if (partial) {
    const first = sorted[0].ledger
    log(`xrpl: ledger ${first} holds ${sorted.filter((e) => e.ledger === first).length} events not yet applied (${sorted.length} in the window); carrying ${events.length} of them (cap ${cfg.maxEventsPerView}, ${XRPL_VIEW_BYTES} bytes)`)
  }
  else if (to !== full) log(`xrpl: window ${from}→${to} ends early (full window ${full}, ${sorted.length} events, cap ${cfg.maxEventsPerView}${cut ? '' : ', history read short'})`)
  // Everything this window still needs, at once: the whole view has about a second per round, and one round trip
  // fits where three in a row do not. The snapshots taken at `full` stand unless the window ended early.
  const proposals = events.flatMap((ev) => {
    if (ev.kind !== 'payment' || ev.to !== cfg.fundingAccount) return []
    const issuer = proposalIssuer(ev.memo)
    return issuer ? [{ ev, issuer, valid: isValidClassicAddress(issuer) }] : []
  })
  const refresh = Math.floor(to / ISSUER_REFRESH_LEDGERS) > Math.floor(from / ISSUER_REFRESH_LEDGERS)
  // A partial view stands still at the cursor: the accounts and issuers keep what the last whole window read, and nothing is read for them. A proposal in it still reads its issuer, at the ledger it was paid in.
  const asOf = partial ? events[0].ledger : to
  const [snaps, answers, issuers] = await Promise.all([
    partial ? Promise.resolve([null, null]) : to === full ? Promise.resolve([lockSnap, fundingSnap]) : Promise.all([accountSnapPinned(cfg, cfg.lockAccount, to, timeoutMs), accountSnapPinned(cfg, cfg.fundingAccount, to, timeoutMs)]),
    Promise.all(proposals.map(({ issuer, valid }) => (valid ? readIssuer(cfg, issuer, asOf, timeoutMs) : Promise.resolve(null)))),
    refresh ? refreshIssuers(state, cfg, to, timeoutMs) : Promise.resolve(null),
  ])
  // A read that failed is not an answer. Putting "unread" into the agreed view would refuse the listing and keep a XRP of
  // the issuer's money for an RPC hiccup, and every node sharing one outage would agree on it. Propose nothing instead:
  // the window is tried again next round, when the read works. (Only an account the ledger says does not exist is a
  // definitive "no issuer" that the machine may refuse.)
  const unread = proposals.findIndex(({ valid }, i) => valid && answers[i] === null)
  if (unread >= 0) {
    log(`xrpl: issuer ${proposals[unread].issuer} could not be read at ledger ${asOf}; proposing nothing for window ${from}→${to}`)
    return null
  }
  proposals.forEach(({ ev }, i) => {
    const read = answers[i]
    ev.issuerFlags = read === 'missing' ? null : read
  })
  const view: XrplView = { src: 'xrpl', from, to, events, accounts: partial ? {} : { [cfg.lockAccount]: snaps[0]!, [cfg.fundingAccount]: snaps[1]! } }
  if (skip > 0) view.skip = skip
  if (issuers && Object.keys(issuers).length) view.issuers = issuers
  return view
}

// ---------------------------------------------------------------- read-only helpers

export async function readBalances(cfg: XrplConfig, tokens: TokenRec[], address: string, timeoutMs: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const [info, lines] = await Promise.all([
    rpc<{ account_data: { Balance: string } }>(cfg.rpc, 'account_info', { account: address, ledger_index: 'validated' }, timeoutMs).catch(() => null),
    rpc<{ lines: { account: string; currency: string; balance: string }[] }>(cfg.rpc, 'account_lines', { account: address, ledger_index: 'validated', limit: 400 }, timeoutMs).catch(() => null),
  ])
  for (const t of tokens) {
    if (t.native) out[t.sym] = info ? dec.fromDrops(info.account_data.Balance) : '0'
    else {
      const line = lines?.lines.find((l) => l.account === t.issuer && l.currency === t.currency)
      out[t.sym] = line ? dec.format(dec.parse(line.balance)) : '0'
    }
  }
  return out
}

export interface AccountCheck {
  exists: boolean
  /** lsfRequireDestTag: payments without a destination tag are refused, and the bridge sends none. */
  requireDestTag: boolean
  /** lsfDepositAuth: only pre-authorized senders can pay in, and the lock account is not one. */
  depositAuth: boolean
  balanceXrp: string
  /** Listed IOU tokens this account holds a trust line for, by symbol. */
  trustlines: Record<string, boolean>
}

/** An account as a release payment would find it. `exists` false when the ledger has no such account (nothing else is known then). */
export async function readAccount(cfg: XrplConfig, tokens: TokenRec[], address: string, timeoutMs: number): Promise<AccountCheck> {
  let info: { account_data: { Flags: number; Balance: string } }
  try {
    info = await rpc(cfg.rpc, 'account_info', { account: address, ledger_index: 'validated' }, timeoutMs)
  } catch (e) {
    if (/actNotFound|Account not found/i.test((e as Error).message)) return { exists: false, requireDestTag: false, depositAuth: false, balanceXrp: '0', trustlines: {} }
    throw e
  }
  const f = Number(info.account_data.Flags) >>> 0
  const trustlines = await readTrustLines(cfg, tokens, address, timeoutMs)
  return { exists: true, requireDestTag: (f & LSF_REQUIRE_DEST_TAG) !== 0, depositAuth: (f & LSF_DEPOSIT_AUTH) !== 0, balanceXrp: dec.fromDrops(String(info.account_data.Balance)), trustlines }
}

export async function readTrustLines(cfg: XrplConfig, tokens: TokenRec[], address: string, timeoutMs: number): Promise<Record<string, boolean>> {
  const lines = await rpc<{ lines: { account: string; currency: string }[] }>(cfg.rpc, 'account_lines', { account: address, ledger_index: 'validated', limit: 400 }, timeoutMs).catch(() => null)
  const out: Record<string, boolean> = {}
  for (const t of tokens) {
    if (t.native) continue
    out[t.sym] = !!lines?.lines.some((l) => l.account === t.issuer && l.currency === t.currency)
  }
  return out
}
