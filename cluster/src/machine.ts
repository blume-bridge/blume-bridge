import { isValidClassicAddress } from 'ripple-address-codec'
import { canon, cmpStr, shortId } from './canon'
import * as dec from './dec'
import { parseDestination } from './destination'
import { returnSrcTxOf, srcTxOf, tokenIdOf } from './evm'
import { DEFAULT_ISSUER_LISTING_FEE_XRP, RATE_ONE, cleanName, erc20Name, erc20Symbol, keyFor, normalizeCurrency, parseImage, parseMeta, parseProposal } from './listing'
import { schedulePayouts, settlePayout } from './payout'
import type { ActionReason, ActionRec, Amount, Direction, EvmActionRec, EvmEvent, EvmView, IssuerFlags, LedgerEvent, OperatorKeys, Params, State, TokenRec, TransferRec, Unmatched, XrplOutgoingEvent, XrplPaymentEvent, XrplView } from './types'

/**
 * The pure state machine. No I/O, no HotPocket, no clock: `now` is the
 * consensus timestamp the caller passes in. Everything the nodes agree on
 * flows through here, so it is unit-tested on its own.
 */

export interface Applied {
  kind: string
  detail: string
}

const SEEN_CAP = 2000
export const UNMATCHED_CAP = 500
/** Expired intents kept as the record of an XRP fee. A loop of intent + fee + expire must not grow consensus state without bound. */
const EXPIRED_KEPT_CAP = 200
/** Intents one user key may hold open when params.maxOpenIntents says nothing. */
export const DEFAULT_MAX_OPEN_INTENTS = 8
/** Intents all user keys together may hold open. */
export const DEFAULT_MAX_OPEN_INTENTS_TOTAL = 300
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
/** One source for the intent id shape: the id check, the lock memo and the fee memo are all built from it. */
const INTENT_ID_SRC = '[0-9a-f]{16}'
const INTENT_ID = new RegExp(`^${INTENT_ID_SRC}$`)
/** The minter's cap bucket: block.timestamp / 1 days, mirrored on consensus time. */
const DAY_MS = 86_400_000
export const DEFAULT_RELEASE_RETRY_MS = 600_000
export const DEFAULT_RELEASE_HOLD_MS = 86_400_000
const EVM_TX = /^0x[0-9a-fA-F]{64}$/

/** The longest a held release waits between tries, in multiples of releaseRetryMs. */
const MAX_RETRY_BACKOFF = 12

/** XRP Ledger pseudo-accounts that nobody holds the key to: a payment there is gone for good. */
const BLACKHOLE_ACCOUNTS = new Set(['rrrrrrrrrrrrrrrrrrrrrhoLvTp', 'rrrrrrrrrrrrrrrrrrrrBZbvji'])

/**
 * Why a release to this account must never be attempted, or null. A burn is final and names its destination in a free
 * string; some valid addresses are not places a release can or should go: the lock account itself (a self-payment, which
 * the ledger rejects before it is ever applied, so it would only sit in the action lane until it expires, again and
 * again), the funding account (the bridge would be paying itself with the burner's backing), the pseudo-accounts nobody
 * holds, and the token's own issuer (an IOU sent to its issuer is redeemed and destroyed). These are minted straight back.
 */
export function unpayableDestination(s: State, token: TokenRec, address: string): string | null {
  if (address === s.config.xrpl.lockAccount) return 'the lock account'
  if (address === s.config.xrpl.fundingAccount) return 'the funding account'
  if (BLACKHOLE_ACCOUNTS.has(address)) return 'an account nobody holds'
  if (token.issuer !== 'native' && address === token.issuer) return "the token's own issuer"
  return null
}

export function releaseRetryMs(s: State): number {
  return s.config.params.releaseRetryMs ?? DEFAULT_RELEASE_RETRY_MS
}
export function releaseHoldMs(s: State): number {
  return s.config.params.releaseHoldMs ?? DEFAULT_RELEASE_HOLD_MS
}

/** A memo on a transaction the cluster sends, so the ledger itself shows what it paid for. */
function memoOf(type: string, data: string): { Memos: { Memo: { MemoType: string; MemoData: string } }[] } {
  const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
  return { Memos: [{ Memo: { MemoType: hex(type), MemoData: hex(data) } }] }
}

/** The token's gross-mint bucket for the UTC day `now` falls in, rolled over when the day changed. */
function mintedToday(token: TokenRec, now: number): string {
  const day = Math.floor(now / DAY_MS)
  if (token.mintDay !== day) {
    token.mintDay = day
    token.mintedToday = '0'
  }
  return token.mintedToday ?? '0'
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/**
 * Past this many units of a token, the amount is not one the minter's 256-bit arithmetic can carry in wei, and a mint of
 * it could never be encoded, let alone confirmed: such a lock is turned away like one over the cap.
 */
export const MAX_UNITS = '1e40'

/** Whether an operator has paused this token, or the whole bridge. Pausing stops new inbound transfers and new mints; burns and releases carry on. */
export function isHeld(s: State, token: TokenRec): boolean {
  return s.paused === true || token.opPaused === true
}

// ---------------------------------------------------------------- intents

export interface TransferIntent {
  dir: Direction
  sym: string
  amount: string
  from: string
  to: string
}

/** Intents a user key has open, and all keys together: waiting for their payments, not lapsed. Counted by the key that asked, never by the `from` it names. One pass. */
function openIntents(state: State, openedBy: string): { mine: number; total: number } {
  let mine = 0
  let total = 0
  for (const t of Object.values(state.transfers)) {
    if (t.step !== 1 || t.failed !== undefined) continue
    total++
    if (t.openedBy === openedBy) mine++
  }
  return { mine, total }
}

/** `openedBy` is the HotPocket user key behind the request; without one (a unit test, a replay) the cap is not applied. */
export function validateIntent(state: State, req: unknown, openedBy?: string): { ok: true; intent: TransferIntent } | { ok: false; error: string } {
  const r = req as Partial<TransferIntent> & { fee?: unknown }
  if (r.dir !== 'in' && r.dir !== 'out') return { ok: false, error: 'dir must be in or out' }
  // Bridging in costs a flat XRP fee and nothing is ever taken from the token. 'xrp' is what the first apps sent to ask for it, so it is still read; 'token' is the fee that was deleted.
  if (r.fee === 'token') return { ok: false, error: 'the token fee no longer exists' }
  if (r.fee !== undefined && r.fee !== null && r.fee !== 'xrp') return { ok: false, error: 'fee must be xrp' }
  if (r.fee === 'xrp' && r.dir !== 'in') return { ok: false, error: 'the XRP fee is for inbound transfers' }
  const sym = String(r.sym ?? '').toUpperCase()
  const token = state.tokens[sym]
  if (!token) return { ok: false, error: `unknown token ${sym}` }
  if (token.status !== 'listed') return { ok: false, error: `${sym} is ${token.status}` }
  if (r.dir === 'in' && isHeld(state, token)) return { ok: false, error: state.paused ? 'the bridge is paused: no new transfers until it resumes' : `${sym} is paused: no new transfers until it resumes` }
  // Parse once, bound it, and only then format: a value like 1e64 parses but formats to a string that no longer parses, and a later dec call on it would throw out of the consensus round.
  let amount: string
  try {
    const n = dec.parse(String(r.amount))
    if (n <= 0n) return { ok: false, error: 'amount must be positive' }
    if (n > dec.parse(MAX_UNITS)) return { ok: false, error: 'amount is too large' }
    amount = dec.format(n)
  } catch {
    return { ok: false, error: 'amount must be a decimal string' }
  }
  const from = String(r.from ?? '')
  const to = String(r.to ?? '')
  if (r.dir === 'in') {
    if (!isValidClassicAddress(from)) return { ok: false, error: 'from must be an r-address' }
    if (!EVM_ADDRESS.test(to)) return { ok: false, error: 'to must be a 0x address' }
    if (to.toLowerCase() === ZERO_ADDRESS) return { ok: false, error: 'to must not be the zero address' }
  } else {
    if (!EVM_ADDRESS.test(from)) return { ok: false, error: 'from must be a 0x address' }
    if (!isValidClassicAddress(to)) return { ok: false, error: 'to must be an r-address' }
  }
  const cap = state.config.params.maxOpenIntents ?? DEFAULT_MAX_OPEN_INTENTS
  const capTotal = state.config.params.maxOpenIntentsTotal ?? DEFAULT_MAX_OPEN_INTENTS_TOTAL
  if (openedBy !== undefined) {
    const open = openIntents(state, openedBy)
    if (open.mine >= cap) return { ok: false, error: `you already have ${cap} open transfers: finish one or wait for it to expire` }
    // Keys are free, so one key's limit does not bound them all: the bridge as a whole holds only so many unfinished transfers.
    if (open.total >= capTotal) return { ok: false, error: 'the bridge has a lot of unfinished transfers right now: try again in a few minutes' }
  }
  return { ok: true, intent: { dir: r.dir, sym, amount, from, to: r.dir === 'in' ? to.toLowerCase() : to } }
}

/** Creates a transfer at step 1 and returns it with the memo the lock payment must carry. */
export function createIntent(state: State, intent: TransferIntent, id: string, now: number, openedBy?: string, inPlace = false): { state: State; transfer: TransferRec } {
  // In place when the caller owns `state` (the round's working copy): cloning the whole state per intent made a flood of them cost the square of their number.
  const s = inPlace ? state : clone(state)
  const transfer: TransferRec = {
    id,
    dir: intent.dir,
    sym: intent.sym,
    amount: intent.amount,
    // The token arrives whole: the fee is a separate payment in XRP.
    receive: intent.amount,
    step: 1,
    sigs: 0,
    sigsNeeded: s.config.k,
    from: intent.from,
    to: intent.to,
    done: false,
    memo: intent.dir === 'in' ? `blume:${id}:${intent.to}` : undefined,
    ...(openedBy !== undefined ? { openedBy } : {}),
    createdAt: now,
    updatedAt: now,
  }
  // The fee is pinned at the quote: params.feeXrp may move before the payment lands, and a payment that paid what it
  // was quoted must not read as underpaid. What arrives overwrites it, so the field is the amount due until the fee is paid.
  if (intent.dir === 'in') transfer.feeXrp = s.config.params.feeXrp
  s.transfers[id] = transfer
  return { state: s, transfer }
}

// ---------------------------------------------------------------- views

/**
 * The order events apply in. The ledger is the unit of causality: what the ledger put first applies first, so a lock that
 * comes ahead of its fee waits for it. Rank only orders events inside one ledger, which is where a Batch lands its inner
 * payments, in arbitrary hash order: our own outgoing transactions first (a return that validated frees its sequence
 * before anything else is judged), then fee payments (a Batch's fee is attached before its lock, which then mints in one
 * step), then proposals, then the rest, locks included, and last the returns, which name a lock that must already be in.
 * The feed cuts a flooded ledger into views in this same order, so the pieces apply as the whole would have.
 */
export function ledgerOrder(config: State['config']): (a: LedgerEvent, b: LedgerEvent) => number {
  const rank = (ev: LedgerEvent): number => {
    if (ev.kind === 'outgoing') return 0
    if (ev.to !== config.xrpl.fundingAccount) return 3
    const kind = classifyFunding(ev).kind
    // A return names a lock that is already in, so it comes after every lock of its ledger.
    return kind === 'fee' ? 1 : kind === 'proposal' ? 2 : kind === 'return' ? 4 : 3
  }
  return (a, b) => a.ledger - b.ledger || rank(a) - rank(b) || cmpStr(a.tx, b.tx)
}

export function applyView(state: State, view: XrplView, now: number): { state: State; applied: Applied[] } {
  if (view.from !== state.cursor.xrpl.ledger) throw new Error(`view starts at ${view.from}, cursor is ${state.cursor.xrpl.ledger}`)
  if ((view.skip ?? 0) !== (state.cursor.xrpl.skip ?? 0)) throw new Error(`view skips ${view.skip ?? 0} events, cursor has applied ${state.cursor.xrpl.skip ?? 0}`)
  const s = clone(state)
  const applied: Applied[] = []
  const events = [...view.events].sort(ledgerOrder(s.config))
  // Issuers first: a return this view queues from the lock account must already know the issuer's current transfer fee.
  for (const [issuer, info] of Object.entries(view.issuers ?? {}).sort(([a], [b]) => cmpStr(a, b))) applied.push(...applyIssuer(s, issuer, info))
  for (const ev of events) {
    if (s.cursor.xrpl.seen.includes(ev.tx)) continue
    s.cursor.xrpl.seen.push(ev.tx)
    if (s.cursor.xrpl.seen.length > SEEN_CAP) s.cursor.xrpl.seen.splice(0, s.cursor.xrpl.seen.length - SEEN_CAP)
    if (ev.kind === 'outgoing') {
      applied.push(applyOutgoing(s, ev, now))
      continue
    }
    if (ev.kind !== 'payment') continue
    // The funding account pays the lock account for the cluster and nobody else (a payout's top-up of the lock account's own XRP). That is not a lock, and recording it as an unmatched one every period would only fill the list people look for their own locks in.
    if (ev.to === s.config.xrpl.lockAccount && ev.from === s.config.xrpl.fundingAccount) applied.push({ kind: 'topup.received', detail: `${ev.amount.value} ${ev.amount.currency} from the funding account (tx ${ev.tx.slice(0, 8)})` })
    else if (ev.to === s.config.xrpl.lockAccount) applied.push(applyLock(s, ev, now))
    else if (ev.to === s.config.xrpl.fundingAccount) applied.push(...applyFunding(s, ev, now))
    else applied.push(unmatched(s, ev, 'not-ours'))
  }
  applied.push(...settleBatches(s, view.to, now))
  for (const [addr, snap] of Object.entries(view.accounts ?? {})) {
    const rec = (s.accounts[addr] ??= { sequence: snap.sequence, ledger: view.to })
    rec.sequence = snap.sequence
    rec.ledger = view.to
    rec.balanceDrops = snap.balanceDrops
  }
  if (view.to > view.from) {
    s.cursor.xrpl.ledger = view.to
    delete s.cursor.xrpl.skip
  } else {
    // Part of the next ledger: the cursor stays, and the next view starts after these events.
    s.cursor.xrpl.skip = (s.cursor.xrpl.skip ?? 0) + view.events.length
  }
  applied.push(...expireActions(s, view.to, now))
  applied.push(...promoteActions(s, view.to, now))
  return { state: s, applied }
}

/**
 * Whether an issuer can still freeze its token: it has not given the power up (NoFreeze) and someone can still sign for its account.
 * A freeze is a transaction the issuer signs, so an issuer locked for good (master key off, no regular key, no signer list) never can,
 * NoFreeze or not; most meme issuers are that, and calling them freezable would be untrue. This is what the "Issuer can freeze" badge says.
 */
export function canFreeze(info: Pick<IssuerFlags, 'noFreeze' | 'blackholed'>): boolean {
  return !info.noFreeze && info.blackholed !== true
}

/**
 * What a fresh read of an issuer changes for its tokens: the transfer fee releases must pay, the domain, the NoFreeze
 * badge, and a pause while the issuer has a global freeze on (a frozen token can only move back to its issuer, so a
 * lock or a release would fail anyway). The pause lifts when the freeze does.
 */
function applyIssuer(s: State, issuer: string, info: IssuerFlags): Applied[] {
  const applied: Applied[] = []
  for (const token of Object.values(s.tokens)) {
    if (token.native || token.issuer !== issuer) continue
    const rate = info.transferRate ?? RATE_ONE
    if (rate > RATE_ONE) token.transferRate = rate
    else delete token.transferRate
    if (info.domain) token.domain = info.domain
    else delete token.domain
    token.noFreezeUnset = canFreeze(info)
    if (info.blackholed === true) token.issuerLocked = true
    else delete token.issuerLocked
    if (info.globalFreeze && token.status === 'listed') {
      token.status = 'paused'
      token.frozen = true
      applied.push({ kind: 'token.paused', detail: `${token.sym}: the issuer froze the token` })
    } else if (!info.globalFreeze && token.status === 'paused' && token.frozen) {
      token.status = 'listed'
      delete token.frozen
      applied.push({ kind: 'token.resumed', detail: `${token.sym}: the issuer lifted its freeze` })
    }
  }
  return applied
}

// ---------------------------------------------------------------- operators

/** Records the operator set once a proposal carries every UNL node's keys. Idempotent. */
export function applyKeys(state: State, set: OperatorKeys[], unl: string[]): { state: State; applied: Applied[] } {
  const nodes = new Set(set.map((o) => o.node))
  if (unl.some((n) => !nodes.has(n)) || nodes.size !== set.length) return { state, applied: [] }
  const next: State['operators'] = {}
  for (const o of [...set].sort((a, b) => cmpStr(a.node, b.node))) next[o.node] = { node: o.node, xrplAddress: o.xrplAddress, xrplPublicKey: o.xrplPublicKey, evmAddress: o.evmAddress, payoutAddress: o.payoutAddress }
  // Canonical on both sides: a reloaded state has its keys sorted, a fresh object has them in insertion order.
  if (canon(next) === canon(state.operators)) return { state, applied: [] }
  const s = clone(state)
  s.operators = next
  return { state: s, applied: [{ kind: 'operators', detail: Object.values(next).map((o) => `${o.node.slice(0, 8)}→${o.xrplAddress}`).join(', ') }] }
}

// ---------------------------------------------------------------- actions

function accountAddress(s: State, account: ActionRec['account']): string {
  return account === 'lock' ? s.config.xrpl.lockAccount : s.config.xrpl.fundingAccount
}

/** Queues a transaction for the cluster to sign. Sequence and expiry are set when it becomes pending. */
export function queueAction(s: State, kind: ActionRec['kind'], account: ActionRec['account'], tx: Record<string, unknown>, reason: ActionReason, now: number, attempts = 0): ActionRec {
  const id = shortId('action', kind, JSON.stringify(reason), String(attempts), String(now), String(Object.keys(s.actions).length))
  const action: ActionRec = {
    id,
    kind,
    account,
    tx: { ...tx, Account: accountAddress(s, account), Fee: s.config.params.xrplFeeDrops },
    status: 'queued',
    reason,
    attempts,
    createdAt: now,
    updatedAt: now,
  }
  // A batch is settled per inner transaction; the slots are filled with sequences at promotion and with results from the ledger.
  if (kind === 'xrpl.batch') action.inner = rawTransactions(action.tx).map(() => ({ sequence: 0 }))
  s.actions[id] = action
  return action
}

/** XLS-56 Batch mode flags: exactly one goes on the outer. */
const BATCH_MODES = new Set([65536, 131072, 262144, 524288])
/** tfInnerBatchTxn: every inner carries it, and no signer will sign a transaction that does. */
const TF_INNER_BATCH_TXN = 1073741824

function rawTransactions(tx: Record<string, unknown>): { RawTransaction: Record<string, unknown> }[] {
  return (tx.RawTransactions as { RawTransaction: Record<string, unknown> }[] | undefined) ?? []
}

/**
 * The outer Batch for 2 to 8 transactions from one of our accounts. The
 * inners are stamped the way the ledger wants them (no fee, no signature,
 * the inner flag); their sequences and the outer's are set at promotion.
 * BatchSigners is not needed: every inner is from the outer's own account.
 */
export function batchTx(account: string, inner: Record<string, unknown>[], flags: number): Record<string, unknown> {
  if (inner.length < 2 || inner.length > 8) throw new Error(`a batch carries 2 to 8 inner transactions, not ${inner.length}`)
  if (!BATCH_MODES.has(flags)) throw new Error(`batch flags must be exactly one mode flag, not ${flags}`)
  return {
    TransactionType: 'Batch',
    Flags: flags,
    RawTransactions: inner.map((tx) => ({ RawTransaction: { ...tx, Account: account, Flags: (Number(tx.Flags ?? 0) | TF_INNER_BATCH_TXN) >>> 0, Fee: '0', SigningPubKey: '' } })),
  }
}

/** Gives the oldest queued action per account the account's next sequence, when nothing else is in flight. */
function promoteActions(s: State, ledger: number, now: number): Applied[] {
  const applied: Applied[] = []
  for (const account of ['lock', 'funding'] as const) {
    const addr = accountAddress(s, account)
    const rec = s.accounts[addr]
    if (!rec || rec.inflight) continue
    const next = Object.values(s.actions)
      .filter((a) => a.status === 'queued' && a.account === account)
      .sort((a, b) => a.createdAt - b.createdAt || cmpStr(a.id, b.id))[0]
    if (!next) continue
    next.sequence = rec.sequence
    next.lastLedger = ledger + s.config.params.actionTtlLedgers
    next.tx = { ...next.tx, Sequence: next.sequence, LastLedgerSequence: next.lastLedger }
    if (next.kind === 'xrpl.batch') {
      // The outer takes S and each inner the next one in order; the expiry stays on the outer alone, an inner may not carry one.
      const seq = next.sequence
      next.tx.RawTransactions = rawTransactions(next.tx).map((r, i) => ({ RawTransaction: { ...r.RawTransaction, Sequence: seq + 1 + i } }))
      next.inner = rawTransactions(next.tx).map((_, i) => ({ sequence: seq + 1 + i }))
    }
    next.status = 'pending'
    next.updatedAt = now
    rec.inflight = next.id
    applied.push({ kind: 'action.pending', detail: `${next.id} ${next.kind} ${account} seq ${next.sequence}${next.inner ? `+${next.inner.length}` : ''} until ${next.lastLedger}` })
  }
  return applied
}

/** A pending action the ledger never showed by its expiry is re-queued (twice), then failed. */
function expireActions(s: State, ledger: number, now: number): Applied[] {
  const applied: Applied[] = []
  for (const action of Object.values(s.actions)) {
    if (action.status !== 'pending' || action.lastLedger === undefined || ledger <= action.lastLedger) continue
    action.status = 'expired'
    action.updatedAt = now
    const rec = s.accounts[accountAddress(s, action.account)]
    if (rec?.inflight === action.id) rec.inflight = undefined
    if (action.attempts < 2) {
      const retry = queueAction(s, action.kind, action.account, unsequenced(action.tx), action.reason, now, action.attempts + 1)
      relink(s, action, retry.id)
      applied.push({ kind: 'action.expired', detail: `${action.id} → retry ${retry.id} (attempt ${retry.attempts})` })
    } else {
      settle(s, action, false, now)
      applied.push({ kind: 'action.failed', detail: `${action.id} expired ${action.attempts + 1} times` })
    }
  }
  return applied
}

function relink(s: State, from: ActionRec, toId: string): void {
  const r = from.reason
  if (r.kind === 'release') {
    const t = s.transfers[r.transferId]
    if (t) t.actionId = toId
  } else if (r.kind === 'return') {
    const target = returnTarget(s, r.tx)
    // Only the return the transfer actually points at: a cap-refused lock returns its own payment and its fee, and the one
    // slot belongs to whichever claimed it. The other is still found by its tx, here and in settle.
    if (target?.kind === 'transfer' && target.transfer.refundActionId === from.id) target.transfer.refundActionId = toId
    else if (target?.kind === 'unmatched' && target.entry.returned === from.id) target.entry.returned = toId
  }
}

/**
 * What a `return` action pays back: a lock the cap refused or its sender asked for back, a lock that matched no intent
 * and was asked for back, or the XRP fee an intent could not keep — whatever became of that intent, so a fee return is
 * linked on a cap refusal as well as on an expiry.
 */
function returnTarget(s: State, tx: string): { kind: 'transfer'; transfer: TransferRec } | { kind: 'unmatched'; entry: Unmatched } | null {
  const transfer = Object.values(s.transfers).find((t) => (t.srcTx === tx && (t.failed === 'cap' || t.failed === 'returned')) || t.feeTx === tx)
  if (transfer) return { kind: 'transfer', transfer }
  const entry = s.unmatched.find((u) => u.tx === tx && u.returned !== undefined)
  return entry ? { kind: 'unmatched', entry } : null
}

/**
 * Sends a payment the cluster cannot use back to whoever paid it. XRP goes
 * back less the fee the account pays to send it; an IOU goes back whole and
 * the account pays the fee from its own XRP. Nothing is queued when the fee
 * would eat the whole amount. `paid` is the event, or what the state kept of
 * it: a fee attached to an intent is known only by its tx and payer.
 */
export function queueReturn(s: State, account: ActionRec['account'], paid: { tx: string; from: string }, amount: Amount, now: number): ActionRec | null {
  let value = amount.value
  if (amount.currency === 'XRP') value = dec.sub(value, dec.fromDrops(s.config.params.xrplFeeDrops))
  if (!dec.gt(value, '0')) return null
  // An IOU leaving the lock account pays its issuer's transfer fee out of itself, like a release.
  const token = account === 'lock' && amount.currency !== 'XRP' ? findTokenByAmount(s, amount) : undefined
  const { deliver: _, ...pay } = token ? lockPayment(token, value) : { Amount: toXrplAmount({ ...amount, value }), deliver: undefined }
  return queueAction(s, 'xrpl.payment', account, { TransactionType: 'Payment', Destination: paid.from, ...pay, ...memoOf('blume/return', paid.tx) }, { kind: 'return', tx: paid.tx, to: paid.from }, now)
}

/**
 * XRP the bridge ends up with, booked as fee revenue (and split like any other): a fee an inbound transfer paid, a
 * return fee, a listing or name-change fee, what a refusal keeps, and what queueReturn could not send back because the
 * return would have cost more than it carried. Everything the funding account keeps goes through here, so its balance
 * and the fee ledger never drift.
 */
function keepXrp(s: State, value: string, sym?: string): void {
  s.fees.xrp = dec.add(s.fees.xrp, value)
  if (sym) s.fees.xrpByToken[sym] = dec.add(s.fees.xrpByToken[sym] ?? '0', value)
}

/**
 * A return the ledger refused (a tec) or never showed, after its last try. What it was for does not end there:
 *  - a lock its sender paid to take back is open again, waiting for its fee or for another `return:` once whatever
 *    refused the payment is put right. The return fee stays earned: the cluster did the work.
 *  - XRP the funding account could not send back is XRP it keeps, so it is booked as the revenue it now is, and the
 *    books follow the balance: the amount, and the network fee as well when the ledger did not take it.
 */
function failedReturn(s: State, action: ActionRec, now: number): void {
  const transfer = Object.values(s.transfers).find((t) => (t.failed === 'returned' || t.failed === 'cap') && t.refundActionId === action.id)
  if (transfer) {
    // A returned lock is waiting again, and its sender can ask once more. A lock the cap refused stays refused but is owed back, with no payment on its way: `return:` and the operator's refund both pick it up.
    if (transfer.failed === 'returned') delete transfer.failed
    delete transfer.refundActionId
    transfer.updatedAt = now
  }
  const stray = s.unmatched.find((u) => u.returned === action.id)
  if (stray) delete stray.returned
  const amount = (action.tx as { Amount?: unknown }).Amount
  if (action.account === 'funding' && typeof amount === 'string') keepXrp(s, dec.add(dec.fromDrops(amount), action.result !== undefined ? '0' : dec.fromDrops(String(action.tx.Fee))))
}

/** Records the outcome of an action on what it was for. */
function settle(s: State, action: ActionRec, ok: boolean, now: number): void {
  const r = action.reason
  if (r.kind === 'release') {
    const t = s.transfers[r.transferId]
    if (!t) return
    t.updatedAt = now
    if (ok) {
      t.step = 5
      t.done = true
      t.dstTx = action.hash
      t.sigs = s.config.k
      delete t.held
    } else {
      // The burn is final; a release the ledger refused (tec: fee taken, nothing delivered) or never validated is not. Hold the transfer: it is retried, and when the hold runs out the tokens go back on the EVM side (holdReleases).
      const result = action.result ?? 'expired'
      // Each refusal doubles the wait (up to 12x), so a burn nobody can pay costs a handful of tries over the hold, not one every few minutes for a day.
      const wait = releaseRetryMs(s) * Math.min(2 ** (t.held?.attempts ?? 0), MAX_RETRY_BACKOFF)
      t.held = { since: t.held?.since ?? now, result, attempts: (t.held?.attempts ?? 0) + 1, retryAt: now + wait }
    }
  } else if (r.kind === 'trustline') {
    const t = s.tokens[r.sym]
    if (t) {
      t.trustLine = ok ? 'set' : 'failed'
      if (ok) delete t.trustLineFailedAt
      else t.trustLineFailedAt = now
    }
  } else if (r.kind === 'return') {
    if (!ok) return failedReturn(s, action, now)
    const target = returnTarget(s, r.tx)
    if (!target) return
    // A cap-refused lock with an XRP fee queues two returns; only the one this transfer linked stamps its hash.
    if (target.kind === 'transfer' && target.transfer.refundActionId === action.id) target.transfer.refundTx = action.hash
  } else if (r.kind === 'payout') {
    // Share by share from the inner slots; `ok` is only the whole-batch verdict.
    settlePayout(s, action, now)
  }
}

/**
 * Whether a transaction our account sent is the one an action holds. The
 * sequence alone is not enough: anything sent from the account at that
 * sequence (the master key on a dev account, an operator by hand) would
 * otherwise settle the transfer as paid. Events from the fake feed carry no
 * destination or amount and match on type alone.
 */
function outgoingMatches(action: ActionRec, ev: XrplOutgoingEvent): boolean {
  const tx = action.tx as { TransactionType?: string; Destination?: string; Amount?: unknown }
  if (ev.type !== tx.TransactionType) return false
  // An outer Batch has no destination or amount of its own; its inner count is the one thing the feed can report about it.
  if (ev.type === 'Batch') return ev.inner === undefined || ev.inner === rawTransactions(action.tx).length
  if (ev.destination !== undefined && ev.destination !== tx.Destination) return false
  if (ev.amount !== undefined) {
    if (typeof tx.Amount === 'string') return ev.amount.currency === 'XRP' && dec.toDrops(ev.amount.value) === tx.Amount
    const a = tx.Amount as Amount | undefined
    if (!a) return false
    return ev.amount.currency === a.currency && ev.amount.issuer === a.issuer && dec.cmp(ev.amount.value, a.value) === 0
  }
  return true
}

/** A transaction our account sent: match it to the action holding that sequence. */
function applyOutgoing(s: State, ev: XrplOutgoingEvent, now: number): Applied {
  const account = ev.account === s.config.xrpl.lockAccount ? 'lock' : ev.account === s.config.xrpl.fundingAccount ? 'funding' : null
  const rec = s.accounts[ev.account]
  if (rec && rec.sequence <= ev.sequence) rec.sequence = ev.sequence + 1
  // An inner of one of our batches is its own ledger transaction at one of the sequences the batch holds; nothing else of ours can be there, because the account is held from the batch's promotion until it settles. Hash order can put an inner before its outer, so the batch may be pending still, or validated earlier in this same view; either way it is never a collision and the account stays held.
  const batch = account ? Object.values(s.actions).find((a) => a.account === account && a.kind === 'xrpl.batch' && (a.status === 'pending' || a.status === 'validated') && a.inner?.some((x) => x.sequence === ev.sequence)) : undefined
  if (batch) {
    const slot = batch.inner!.find((x) => x.sequence === ev.sequence)!
    slot.hash = ev.tx
    slot.result = ev.result
    batch.updatedAt = now
    return { kind: 'batch.inner', detail: `${batch.id} seq ${ev.sequence} ${ev.result} tx ${ev.tx.slice(0, 8)}` }
  }
  const action = account ? Object.values(s.actions).find((a) => a.account === account && a.status === 'pending' && a.sequence === ev.sequence) : undefined
  if (!action) return { kind: 'outgoing.unmatched', detail: `${ev.account.slice(0, 8)} ${ev.type} seq ${ev.sequence} ${ev.result} tx ${ev.tx.slice(0, 8)}` }
  if (!outgoingMatches(action, ev)) {
    // Something else took this sequence, so ours never went in. It goes back in the queue under a new id: signatures over the old sequence die with the old one.
    action.status = 'expired'
    action.result = `sequence taken by ${ev.tx}`
    action.updatedAt = now
    if (rec?.inflight === action.id) rec.inflight = undefined
    const retry = queueAction(s, action.kind, action.account, unsequenced(action.tx), action.reason, now, action.attempts)
    relink(s, action, retry.id)
    return { kind: 'action.collided', detail: `${action.id} seq ${ev.sequence} taken by ${ev.type} ${ev.tx.slice(0, 8)} (${ev.result}); re-queued as ${retry.id}` }
  }
  const ok = ev.result === 'tesSUCCESS'
  action.status = ok ? 'validated' : 'failed'
  action.hash = ev.tx
  action.result = ev.result
  action.updatedAt = now
  // An outer Batch is tesSUCCESS even when its inners fail, so it settles by the inner events instead (settleBatches) and keeps the account until then. A refused outer applied nothing and fails like any other action.
  if (action.kind === 'xrpl.batch' && ok) return { kind: 'action.validated', detail: `${action.id} ${action.kind} ${ev.result} tx ${ev.tx.slice(0, 8)}; awaiting ${action.inner?.length ?? 0} inner` }
  if (rec?.inflight === action.id) rec.inflight = undefined
  settle(s, action, ok, now)
  return { kind: ok ? 'action.validated' : 'action.failed', detail: `${action.id} ${action.kind} ${ev.result} tx ${ev.tx.slice(0, 8)}` }
}

// ---------------------------------------------------------------- releases and test burns

export function releaseAmount(token: TokenRec, value: string): Amount {
  return token.native ? { currency: 'XRP', value } : { currency: token.currency!, issuer: token.issuer, value }
}

function toXrplAmount(amount: Amount): unknown {
  return amount.currency === 'XRP' ? dec.toDrops(amount.value) : { currency: amount.currency, issuer: amount.issuer, value: amount.value }
}

/** The largest amount at or below `value` an XRPL payment can carry: whole drops for XRP, 15 significant digits for an IOU. */
function carriedAmount(token: TokenRec, value: string): string {
  return token.native ? dec.floorToDrops(value) : dec.toSignificant(value, 15)
}

/**
 * The amounts of a payment that takes `gross` out of the lock account. When the issuer charges a transfer fee the
 * sender pays it on top of what arrives, so the payment asks to deliver gross ÷ rate and caps its spend at gross with
 * SendMax: the lock account never spends more than it holds against the transfer, and whoever is paid bears the
 * issuer's fee, as on any other transfer of that token. The delivered amount is shaved by a billionth so the ledger's
 * own rounding of the fee can never need more than SendMax; the shaving stays in the lock account. If the issuer has
 * raised its fee since the last read the payment fails, is held, and its retry uses the fresh rate.
 */
function lockPayment(token: TokenRec, gross: string): { Amount: unknown; SendMax?: unknown; deliver?: string } {
  const amount = releaseAmount(token, gross)
  const rate = token.transferRate ?? RATE_ONE
  if (token.native || rate <= RATE_ONE) return { Amount: toXrplAmount(amount) }
  const deliver = dec.toSignificant(dec.mulRatio(gross, RATE_ONE - 1, rate), 15)
  return { Amount: toXrplAmount({ ...amount, value: deliver }), SendMax: toXrplAmount(amount), deliver }
}

/**
 * A burn is final, and the books follow it: the ERC-20 supply fell by the whole amount, so what backs the supply does
 * too (`lockedUnits`), and what the ledger could not carry stays in the lock account as surplus (`dustUnits`). The lock
 * account then holds lockedUnits + dustUnits of the token, which anyone can check against the supply.
 */
function burned(token: TokenRec, amount: string, carried: string): void {
  token.lockedUnits = dec.cmp(token.lockedUnits, amount) >= 0 ? dec.sub(token.lockedUnits, amount) : '0'
  token.dustUnits = dec.add(token.dustUnits, dec.sub(amount, carried))
}

/** Queues the release payment for an outbound transfer whose burn is agreed. */
export function queueRelease(s: State, transfer: TransferRec, now: number): ActionRec | null {
  const token = s.tokens[transfer.sym]
  if (!token || transfer.dir !== 'out') return null
  // The burn tx rides in the memo, so the ledger shows which burn a release paid without asking the cluster.
  const memo = transfer.srcTx ? memoOf('blume/burn', transfer.srcTx) : {}
  const { deliver, ...pay } = lockPayment(token, transfer.receive)
  if (deliver) transfer.deliver = deliver
  else delete transfer.deliver
  const tag = transfer.destTag !== undefined ? { DestinationTag: transfer.destTag } : {}
  const action = queueAction(s, 'xrpl.payment', 'lock', { TransactionType: 'Payment', Destination: transfer.to, ...tag, ...pay, ...memo }, { kind: 'release', transferId: transfer.id }, now)
  transfer.actionId = action.id
  transfer.step = 3
  transfer.updatedAt = now
  return action
}

export function validateTestBurn(state: State, req: unknown): { ok: true; sym: string; amount: string; to: string; from: string } | { ok: false; error: string } {
  if (!state.config.testHooks) return { ok: false, error: 'test hooks are off' }
  const r = req as { sym?: string; amount?: string; to?: string; from?: string }
  const sym = String(r.sym ?? '').toUpperCase()
  const token = state.tokens[sym]
  if (!token || token.status !== 'listed') return { ok: false, error: `${sym} is not listed` }
  let amount: string
  try {
    amount = dec.format(dec.parse(String(r.amount)))
  } catch {
    return { ok: false, error: 'amount must be a decimal string' }
  }
  if (!dec.gt(amount, '0')) return { ok: false, error: 'amount must be positive' }
  if (dec.gt(amount, token.lockedUnits)) return { ok: false, error: `only ${token.lockedUnits} ${sym} is locked` }
  if (!isValidClassicAddress(String(r.to ?? ''))) return { ok: false, error: 'to must be an r-address' }
  const from = String(r.from ?? '0x0000000000000000000000000000000000000000')
  if (!EVM_ADDRESS.test(from)) return { ok: false, error: 'from must be a 0x address' }
  return { ok: true, sym, amount, to: String(r.to), from: from.toLowerCase() }
}

/** A pretend burn: an outbound transfer at step 2 with a fake source tx, and its release queued. */
export function createTestBurn(state: State, burn: { sym: string; amount: string; to: string; from: string }, id: string, now: number): { state: State; transfer: TransferRec; action: ActionRec } {
  const s = clone(state)
  const token = s.tokens[burn.sym]
  // What the ledger can carry; the remainder stays in the lock account as surplus backing.
  const receive = carriedAmount(token, burn.amount)
  const transfer: TransferRec = {
    id,
    dir: 'out',
    sym: burn.sym,
    amount: burn.amount,
    receive,
    step: 2,
    sigs: 0,
    sigsNeeded: s.config.k,
    from: burn.from,
    to: burn.to,
    srcTx: `TESTBURN-${id}`,
    done: false,
    createdAt: now,
    updatedAt: now,
  }
  s.transfers[id] = transfer
  burned(token, burn.amount, receive)
  const action = queueRelease(s, transfer, now)!
  return { state: s, transfer, action }
}


/** Expiries and the work that is due. Runs every round whether or not a view was agreed. */
export function tick(state: State, now: number): { state: State; applied: Applied[] } {
  const s = clone(state)
  const applied: Applied[] = []
  for (const [id, t] of Object.entries(s.transfers)) {
    if (t.step !== 1) continue
    if (t.failed) {
      // Already lapsed. The only thing left to do is on one whose fee attached afterwards, when its Batch reached the ledger in pieces: that fee goes straight back, the intent is long gone.
      if (t.failed !== 'expired' || !t.feeTx || t.refundActionId) continue
    } else if (now <= (t.feeTx ? t.updatedAt : t.createdAt) + s.config.intentTtlMs) {
      // A fee restarts the clock: a Batch whose fee lands in the very round the intent would lapse must still get its lock in.
      continue
    }
    if (t.feeTx) {
      // The fee arrived, the lock never did: the transfer stays as the record of the fee going back.
      t.failed = 'expired'
      t.updatedAt = now
      const action = queueReturn(s, 'funding', { tx: t.feeTx, from: t.from }, { currency: 'XRP', value: t.feeXrp! }, now)
      if (action) t.refundActionId = action.id
      else {
        // The return would cost more than it carried: the XRP stays and is booked, and the record has no return to wait for.
        keepXrp(s, t.feeXrp!, t.sym)
        delete s.transfers[id]
      }
      applied.push({ kind: 'intent.expired', detail: `${id}; fee ${t.feeXrp} XRP ${action ? `returned by ${action.id}` : 'kept (below the fee)'}` })
      continue
    }
    if (t.dir === 'in') {
      // Its Batch may still validate: the fee and the lock it brings revive this record, so a payer who signed in time is not charged twice for being slow.
      t.failed = 'expired'
      t.updatedAt = now
      applied.push({ kind: 'intent.expired', detail: `${id}; kept for its Batch` })
      continue
    }
    delete s.transfers[id]
    applied.push({ kind: 'intent.expired', detail: id })
  }
  applied.push(...pruneExpiredIntents(s))
  applied.push(...holdReleases(s, now))
  applied.push(...queueTrustLines(s, now))
  applied.push(...queueEvmWork(s, now))
  applied.push(...schedulePayouts(s, now))
  return { state: s, applied }
}

/**
 * An expired intent is kept for what is still owed on it: a fee return the ledger has not finished with, or the Batch that
 * may yet revive it. Once the return has validated or failed for good the actions are the audit trail and the record goes.
 * What is left is capped, so a loop of intent + fee + expire cannot grow consensus state without bound.
 */
function pruneExpiredIntents(s: State): Applied[] {
  const applied: Applied[] = []
  const kept: TransferRec[] = []
  for (const t of Object.values(s.transfers)) {
    if (t.step !== 1 || t.failed !== 'expired') continue
    const action = t.refundActionId ? s.actions[t.refundActionId] : undefined
    if (action && (action.status === 'validated' || action.status === 'failed')) {
      delete s.transfers[t.id]
      applied.push({ kind: 'intent.settled', detail: `${t.id}; fee return ${action.id} ${action.status}` })
      continue
    }
    kept.push(t)
  }
  if (kept.length <= EXPIRED_KEPT_CAP) return applied
  for (const t of kept.sort((a, b) => a.createdAt - b.createdAt || cmpStr(a.id, b.id)).slice(0, kept.length - EXPIRED_KEPT_CAP)) {
    delete s.transfers[t.id]
    applied.push({ kind: 'intent.dropped', detail: t.id })
  }
  return applied
}

/**
 * Held transfers: retry the release while the hold lasts (the destination
 * may add its trust line), then mint the tokens back to the burner. A burn to
 * something that is not an address is held `final`: it goes straight back.
 * Nothing happens while a release action is still open, so a retry and a
 * return can never both pay. The return waits for a day with room under the
 * cap rather than queue a mint the minter would refuse.
 */
function holdReleases(s: State, now: number): Applied[] {
  const applied: Applied[] = []
  for (const t of Object.values(s.transfers)) {
    if (t.dir !== 'out' || !t.held || t.done || t.failed || t.returnEvmActionId) continue
    const open = t.actionId ? s.actions[t.actionId] : undefined
    if (open && (open.status === 'queued' || open.status === 'pending')) continue
    const token = s.tokens[t.sym]
    if (!token) continue
    if (t.held.final || now >= t.held.since + releaseHoldMs(s)) {
      if (!s.config.evm || !token.evmAddress || Object.keys(s.operators).length < s.config.n || !t.srcTx || !EVM_TX.test(t.srcTx)) continue
      const today = mintedToday(token, now)
      // The whole burn goes back, the part the ledger could not have carried included: the ERC-20 has room for it.
      if (token.capUnits !== undefined && dec.gt(dec.add(today, t.amount), token.capUnits)) continue
      // Keyed by the burn's tx and log index: the minter allows one mint per source, and one transaction can hold several burns.
      const key = t.srcLog === undefined ? srcTxOf(t.srcTx) : returnSrcTxOf(t.srcTx, t.srcLog)
      const a = queueEvmAction(s, 'mint', { tokenId: tokenIdOf(token), to: t.from, amount: toWei(t.amount), srcTx: key }, { kind: 'mint', transferId: t.id }, now)
      t.returnEvmActionId = a.id
      t.returnKey = key
      t.held.retryAt = undefined
      t.updatedAt = now
      // The tokens are outstanding again, backed by what never left the lock account, and the surplus the burn set aside backs them again.
      token.lockedUnits = dec.add(token.lockedUnits, t.amount)
      const surplus = dec.sub(t.amount, t.receive)
      token.dustUnits = dec.cmp(token.dustUnits, surplus) >= 0 ? dec.sub(token.dustUnits, surplus) : '0'
      token.mintedToday = dec.add(today, t.amount)
      applied.push({ kind: 'release.returned', detail: `${t.id} ${t.amount} ${t.sym} back to ${t.from} (${t.held.result} after ${t.held.attempts} attempts); mint ${a.id} relayer ${a.relayer}` })
      continue
    }
    if (t.held.retryAt !== undefined && now >= t.held.retryAt) {
      const a = queueRelease(s, t, now)
      t.held.retryAt = undefined
      applied.push({ kind: 'release.retry', detail: `${t.id} attempt ${t.held.attempts + 1} after ${t.held.result}; ${a?.id} queued` })
    }
  }
  return applied
}

// ---------------------------------------------------------------- EVM side

function evmActionIdFor(s: State, kind: EvmActionRec['kind'], reason: EvmActionRec['reason'], now: number): string {
  return shortId('evm', kind, JSON.stringify(reason), String(Object.keys(s.evmActions).length), String(now))
}

export function queueEvmAction(s: State, kind: EvmActionRec['kind'], data: Record<string, string>, reason: EvmActionRec['reason'], now: number): EvmActionRec {
  const id = evmActionIdFor(s, kind, reason, now)
  const n = Math.max(1, Object.keys(s.operators).length)
  const action: EvmActionRec = { id, kind, status: 'pending', data, reason, relayer: parseInt(id.slice(0, 8), 16) % n, relayAt: now, attempts: 0, createdAt: now, updatedAt: now }
  s.evmActions[id] = action
  return action
}

/** Units → wei as a decimal string (tokens have 18 decimals on the EVM side). */
export function toWei(units: string): string {
  return dec.parse(units).toString()
}
export function fromWei(wei: string): string {
  return dec.format(BigInt(wei))
}
/** What the v3 minter calls no limit at all: type(uint256).max. A cap sent to the minter for a token the cluster does not cap. */
const UNCAPPED_WEI = (2n ** 256n - 1n).toString()
/** Past this many wei a cap is not a limit anyone can reach, and not a number a decimal here can hold. */
const NO_LIMIT_WEI = 2n ** 128n

/**
 * The minter's daily cap as the cluster's lock cap. A cap of 0 mints nothing (the v3 minter; it is what a new listing is
 * put on with in production), so the cluster takes no deposits for the token either, instead of taking locks it cannot
 * mint against. UNCAPPED, or anything too large to be a limit, is no cap at all.
 */
function capFromWei(wei: string): string | undefined {
  return BigInt(wei) >= NO_LIMIT_WEI ? undefined : fromWei(wei)
}

/**
 * Every listed token without an ERC-20 gets a listing action; every agreed
 * lock whose token has an ERC-20 gets a mint action. Idempotent, runs every
 * round, needs the operator set (the relayer is one of them).
 */
export function queueEvmWork(s: State, now: number): Applied[] {
  const applied: Applied[] = []
  if (!s.config.evm || Object.keys(s.operators).length < s.config.n) return applied
  for (const token of Object.values(s.tokens)) {
    if (!s.cursor.evm?.synced) break
    if (token.status !== 'listed' || token.evmAddress || token.evmActionId) continue
    // The token's own cap when genesis gave it one; a token listed since has capUnits '0' until the minter confirms its listing, and is listed with the default cap. That default is 0 in production: on the v3 minter a daily cap of 0 mints nothing until an operator raises it (on a v2 minter it would mean no limit at all, which is why the test profile never uses it).
    // A seed the genesis gave no cap at all is listed with no limit (the minter reads 2^256-1 as uncapped), and so is a listing that opens by itself; a token with a cap is listed with it. Anything else takes the default, which is 0 in production.
    const dailyCap = token.capUnits && dec.gt(token.capUnits, '0') ? toWei(token.capUnits) : (token.lane === 'genesis' && token.capUnits === undefined) || token.autoOpen ? UNCAPPED_WEI : toWei(s.config.params.defaultCapUnits)
    const a = queueEvmAction(s, 'list', { tokenId: tokenIdOf(token), name: erc20Name(token), symbol: erc20Symbol(token), imageURI: token.image ?? '', dailyCap }, { kind: 'list', sym: token.sym }, now)
    token.evmActionId = a.id
    applied.push({ kind: 'evm.list', detail: `${a.id} ${token.sym} relayer ${a.relayer}` })
  }
  // A metadata change the ERC-20 does not carry yet goes out as one signed update, with the next nonce the minter
  // takes; one at a time per token, carrying the latest name and logo, so updates that pile up while one is in flight
  // cost a single transaction once it confirms. The cap rides along unchanged: a token the cluster does not cap goes on
  // as UNCAPPED, never as 0, which the v3 minter reads as no mints at all.
  for (const token of Object.values(s.tokens)) {
    if (!s.cursor.evm?.synced) break
    if (!token.evmAddress || token.evmUpdateActionId || (token.metaVersion ?? 0) <= (token.evmMetaVersion ?? 0)) continue
    const nonce = (token.evmMetaNonce ?? 0) + 1
    const data = { tokenId: tokenIdOf(token), name: erc20Name(token), symbol: erc20Symbol(token), imageURI: token.image ?? '', dailyCap: token.capUnits === undefined ? UNCAPPED_WEI : toWei(token.capUnits), nonce: String(nonce), version: String(token.metaVersion) }
    const a = queueEvmAction(s, 'update', data, { kind: 'update', sym: token.sym, nonce }, now)
    token.evmUpdateActionId = a.id
    applied.push({ kind: 'evm.update', detail: `${a.id} ${token.sym} nonce ${nonce} relayer ${a.relayer}` })
  }
  for (const t of Object.values(s.transfers)) {
    if (t.dir !== 'in' || t.step !== 3 || t.failed || t.evmActionId || !t.srcTx) continue
    const token = s.tokens[t.sym]
    if (!token?.evmAddress || isHeld(s, token)) continue
    const a = queueEvmAction(s, 'mint', { tokenId: tokenIdOf(token), to: t.to, amount: toWei(t.receive), srcTx: srcTxOf(t.srcTx) }, { kind: 'mint', transferId: t.id }, now)
    t.evmActionId = a.id
    t.updatedAt = now
    applied.push({ kind: 'evm.mint', detail: `${a.id} ${t.receive} ${t.sym} → ${t.to} relayer ${a.relayer}` })
  }
  return applied
}

function confirmEvmAction(s: State, id: string | undefined, hash: string, now: number): void {
  const a = id ? s.evmActions[id] : undefined
  if (!a || a.status !== 'pending') return
  a.status = 'confirmed'
  a.hash = hash
  a.updatedAt = now
}

export function applyEvmView(state: State, view: EvmView, now: number): { state: State; applied: Applied[] } {
  const s = clone(state)
  const cfg = s.config.evm
  if (!cfg) return { state, applied: [] }
  s.cursor.evm ??= { block: view.from, seen: [] }
  if (view.from !== s.cursor.evm.block) throw new Error(`evm view starts at ${view.from}, cursor is ${s.cursor.evm.block}`)
  if ((view.skip ?? 0) !== (s.cursor.evm.skip ?? 0)) throw new Error(`evm view skips ${view.skip ?? 0} events, cursor has applied ${s.cursor.evm.skip ?? 0}`)
  const applied: Applied[] = []
  const byTokenId = new Map(Object.values(s.tokens).map((t) => [tokenIdOf(t).toLowerCase(), t] as const))
  const byAddress = new Map(Object.values(s.tokens).filter((t) => t.evmAddress).map((t) => [t.evmAddress!.toLowerCase(), t] as const))
  for (const [id, listing] of Object.entries(view.listings ?? {})) {
    const token = byTokenId.get(id.toLowerCase())
    if (!token || token.evmAddress) continue
    token.evmAddress = listing.token
    token.capUnits = capFromWei(listing.dailyCapWei)
    // An update must carry the minter's next nonce, which a token listed before this state began may already have used.
    if (listing.metaNonce && Number(listing.metaNonce) > 0) token.evmMetaNonce = Number(listing.metaNonce)
    byAddress.set(listing.token.toLowerCase(), token)
    confirmEvmAction(s, token.evmActionId, 'pre-existing', now)
    applied.push({ kind: 'evm.known', detail: `${token.sym} already listed at ${listing.token} cap ${token.capUnits ?? 'none'}` })
  }
  const events = [...view.events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  for (const ev of events) {
    const key = `${ev.tx}:${ev.logIndex}`
    if (s.cursor.evm.seen.includes(key)) continue
    s.cursor.evm.seen.push(key)
    if (s.cursor.evm.seen.length > SEEN_CAP) s.cursor.evm.seen.splice(0, s.cursor.evm.seen.length - SEEN_CAP)
    if (ev.kind === 'listed') {
      const token = byTokenId.get(ev.tokenId.toLowerCase())
      if (!token) {
        applied.push({ kind: 'evm.listed.unknown', detail: ev.tokenId.slice(0, 10) })
        continue
      }
      token.evmAddress = ev.token
      token.capUnits = capFromWei(ev.dailyCapWei)
      byAddress.set(ev.token.toLowerCase(), token)
      confirmEvmAction(s, token.evmActionId, ev.tx, now)
      applied.push({ kind: 'evm.listed', detail: `${token.sym} → ${ev.token} cap ${token.capUnits ?? 'none'}` })
    } else if (ev.kind === 'updated') {
      const token = byTokenId.get(ev.tokenId.toLowerCase())
      if (!token) {
        applied.push({ kind: 'evm.updated.unknown', detail: ev.tokenId.slice(0, 10) })
        continue
      }
      const nonce = Number(ev.nonce)
      if (nonce > (token.evmMetaNonce ?? 0)) token.evmMetaNonce = nonce
      const a = token.evmUpdateActionId ? s.evmActions[token.evmUpdateActionId] : undefined
      // The cap the minter now holds is the cluster's cap, unless an operator has changed it again since this update was queued: that newer value (an emergency 0, say) is what the next update carries, and the confirmation of the older one must not put the old figure back.
      const superseded = !!a && a.data.nonce === ev.nonce && Number(a.data.version) < (token.metaVersion ?? 0)
      if (!superseded) token.capUnits = capFromWei(ev.dailyCapWei)
      if (a && a.data.nonce === ev.nonce) {
        token.evmMetaVersion = Math.max(token.evmMetaVersion ?? 0, Number(a.data.version))
        confirmEvmAction(s, a.id, ev.tx, now)
        delete token.evmUpdateActionId
      }
      applied.push({ kind: 'evm.updated', detail: `${token.sym} nonce ${nonce} cap ${token.capUnits ?? 'none'} tx ${ev.tx.slice(0, 10)}` })
    } else if (ev.kind === 'mint') {
      // An inbound mint is keyed by the lock's XRPL hash; a return mint by its burn (tx and log index). Transfers held before the key existed used the burn tx alone.
      const t = Object.values(s.transfers).find((x) => x.srcTx && (x.dir === 'in' ? srcTxOf(x.srcTx).toLowerCase() === ev.srcTx.toLowerCase() : x.returnEvmActionId !== undefined && (x.returnKey ?? srcTxOf(x.srcTx)).toLowerCase() === ev.srcTx.toLowerCase()))
      if (!t) {
        applied.push({ kind: 'evm.mint.unknown', detail: `${ev.srcTx.slice(0, 10)} ${ev.amountWei}` })
        continue
      }
      if (t.dir === 'out') {
        // A held release given back: the transfer ends here, with the tokens in the burner's wallet again.
        t.failed = 'returned'
        t.returnTx = ev.tx
        t.updatedAt = now
        confirmEvmAction(s, t.returnEvmActionId, ev.tx, now)
        applied.push({ kind: 'evm.returned', detail: `${t.id} ${fromWei(ev.amountWei)} ${t.sym} → ${ev.to} tx ${ev.tx.slice(0, 10)}` })
        continue
      }
      t.step = 5
      t.done = true
      t.dstTx = ev.tx
      t.sigs = s.config.k
      t.updatedAt = now
      confirmEvmAction(s, t.evmActionId, ev.tx, now)
      applied.push({ kind: 'evm.minted', detail: `${t.id} ${fromWei(ev.amountWei)} ${t.sym} → ${ev.to} tx ${ev.tx.slice(0, 10)}` })
    } else if (ev.kind === 'burn') {
      const token = byAddress.get(ev.token.toLowerCase())
      if (!token) {
        applied.push({ kind: 'evm.burn.unknown', detail: `${ev.token} ${ev.amountWei}` })
        continue
      }
      const id = shortId('burn', ev.tx, String(ev.logIndex))
      const amount = fromWei(ev.amountWei)
      // What the ledger can carry: the ERC-20 has 18 decimals, the ledger 15 significant digits (whole drops for XRP).
      const receive = carriedAmount(token, amount)
      // A classic address, or an X-address that carries a destination tag: decode it once, here, so the release pays the account and tags it.
      const dest = parseDestination(ev.rAddress, s.config.xrpl.network)
      const unpayable = dest ? unpayableDestination(s, token, dest.address) : null
      const transfer: TransferRec = { id, dir: 'out', sym: token.sym, amount, receive, step: 2, sigs: 0, sigsNeeded: s.config.k, from: ev.from, to: dest?.address ?? ev.rAddress, ...(dest?.tag !== undefined ? { destTag: dest.tag } : {}), srcTx: ev.tx, srcLog: ev.logIndex, done: false, createdAt: now, updatedAt: now }
      s.transfers[id] = transfer
      if (dec.gt(amount, token.lockedUnits)) {
        // More burned than the lock account holds for this token: the supply cannot exceed what is locked, so this log is wrong (a lying server, a fork) or the books drifted. A release would pay out other holders' backing, and a return mint would create unbacked tokens for whoever the log names. Neither happens: the token stops taking deposits, and an operator looks.
        transfer.failed = 'unbacked'
        token.opPaused = true
        applied.push({ kind: 'evm.burn.unbacked', detail: `${id} ${amount} ${token.sym} burned by ${ev.from.slice(0, 8)} but only ${token.lockedUnits} is locked; no release, ${token.sym} paused` })
        continue
      }
      burned(token, amount, receive)
      if (dec.isZero(receive)) {
        // Nothing a payment could carry (a zero burn, or less than a drop). The lock account keeps it as surplus; a zero-amount Payment would only jam the queue.
        transfer.failed = 'dust'
        applied.push({ kind: 'evm.burn.dust', detail: `${id} ${amount} ${token.sym} from ${ev.from.slice(0, 8)}` })
        continue
      }
      if (!dest || unpayable) {
        // No release can ever pay this, so there is nothing to wait out: the tokens are minted back to the burner, not dropped (holdReleases).
        transfer.held = { since: now, result: 'bad-destination', attempts: 0, final: true }
        applied.push({ kind: 'evm.burn.bad-destination', detail: `${id} ${amount} ${token.sym} to ${JSON.stringify(ev.rAddress)}${unpayable ? ` (${unpayable})` : ''}; minted back to ${ev.from.slice(0, 8)}` })
        continue
      }
      const action = queueRelease(s, transfer, now)
      applied.push({ kind: 'evm.burn', detail: `${id} ${amount} ${token.sym} from ${ev.from.slice(0, 8)} → ${ev.rAddress}; release ${action?.id} queued` })
    }
  }
  if (view.to > view.from) {
    s.cursor.evm.block = view.to
    delete s.cursor.evm.skip
  } else {
    // Part of the next block: the cursor stays, and the next view starts after these events.
    s.cursor.evm.skip = (s.cursor.evm.skip ?? 0) + view.events.length
  }
  s.cursor.evm.synced = true
  // Relayer rotation: a pending action whose relayer has had its time moves to the next operator.
  const n = Math.max(1, Object.keys(s.operators).length)
  for (const a of Object.values(s.evmActions)) {
    if (a.status !== 'pending') continue
    if (now - a.relayAt < cfg.relayTimeoutMs) continue
    a.relayAt = now
    a.attempts++
    if (a.attempts >= 3 * n && a.reason.kind === 'update') {
      // A metadata update is the one action that can be replaced instead of waited for: free the slot, and the next
      // queueEvmWork sends the latest metadata again with whatever nonce the minter is at.
      a.status = 'failed'
      a.updatedAt = now
      const token = s.tokens[a.reason.sym]
      if (token?.evmUpdateActionId === a.id) delete token.evmUpdateActionId
      applied.push({ kind: 'evm.action.failed', detail: `${a.id} ${a.kind} after ${a.attempts} relayers` })
      continue
    }
    // A listing, a mint or a return mint is never given up on. The lock behind a mint is real and its tokens are held on
    // the XRP Ledger, so failing the action would strand them: an RPC outage or a chain halt of any length has to be
    // waited out, relayer after relayer, with the minter's own guards (one mint per lock, one listing per token) making
    // every retry safe. Attempts above the operator count are what the watchdog alerts on.
    a.relayer = (a.relayer + 1) % n
    a.updatedAt = now
    applied.push({ kind: 'evm.relayer', detail: `${a.id} → operator ${a.relayer}${a.attempts >= 3 * n ? ` (attempt ${a.attempts}, still trying)` : ''}` })
  }
  applied.push(...queueEvmWork(s, now))
  return { state: s, applied }
}

// ---------------------------------------------------------------- locks

/** `blume:<intent id>` as the lock payment carries it, with the destination the app appends (`blume:<id>:<0x…>`). The intent holds the real destination, so the one in the memo is never used. */
const LOCK_MEMO = new RegExp(`^blume:(${INTENT_ID_SRC})(?::0x[0-9a-fA-F]{40})?$`, 'i')

/** The intent a lock payment names, or null. A bare 0x… memo names none and never mints: the fee is attached to an intent, so a lock without one has no fee behind it. */
function parseLockMemo(memo: string | null): string | null {
  const match = LOCK_MEMO.exec((memo ?? '').trim())
  return match ? match[1].toLowerCase() : null
}

export function findTokenByAmount(state: State, amount: Amount): TokenRec | undefined {
  if (amount.currency === 'XRP') return Object.values(state.tokens).find((t) => t.native)
  return Object.values(state.tokens).find((t) => !t.native && t.currency === amount.currency && t.issuer === amount.issuer)
}

function applyLock(s: State, ev: XrplPaymentEvent, now: number): Applied {
  const token = findTokenByAmount(s, ev.amount)
  if (!token) return unmatched(s, ev, 'unknown-token')
  if (token.status !== 'listed') return unmatched(s, ev, `token-${token.status}`)
  // Below 1e-18 the amount formats to zero: nothing to mint, and a zero mint would spend the one mint the minter allows per lock tx.
  if (dec.isZero(ev.amount.value)) return unmatched(s, ev, 'dust')
  const intentId = parseLockMemo(ev.memo)
  const transfer = intentId ? s.transfers[intentId] : undefined
  if (!transfer || transfer.dir !== 'in' || transfer.sym !== token.sym) return unmatched(s, ev, 'no-intent')
  // An intent that lapsed is still the one its Batch belongs to when the Batch brings the fee with it: the fee applies
  // first in the ledger, and this lock takes the record back. One whose fee has already been sent back is finished.
  const revive = transfer.failed === 'expired' && !!transfer.feeTx && !transfer.refundActionId
  if (transfer.step !== 1 || (transfer.failed !== undefined && !revive)) return unmatched(s, ev, 'intent-closed')
  // The memo is on the ledger as soon as the fee is, so anyone can pay a lock for this intent. Someone other than the
  // account the intent named has to bring at least what was quoted: a dust lock must not close somebody else's intent
  // and spend their fee on nothing. The account the intent named may bring any amount, and gets it minted.
  if (ev.from !== transfer.from && dec.cmp(ev.amount.value, transfer.amount) < 0) return unmatched(s, ev, 'intent-underpaid')
  // Live again if it had lapsed: the fee it holds is what mints the full amount.
  delete transfer.failed
  transfer.amount = ev.amount.value
  transfer.srcTx = ev.tx
  transfer.srcLedger = ev.ledger
  transfer.lockFrom = ev.from
  // It is no longer open, so it stops counting against whoever asked for it.
  delete transfer.openedBy
  transfer.updatedAt = now
  transfer.step = 2
  // No fee, no mint. The tokens stay in the lock account, `lockedUnits` does not move, nothing is sent back on the
  // cluster's own account and nothing expires: the fee that arrives later completes the lock, or its sender pays
  // `return:` to have it back.
  if (!transfer.feeTx) return { kind: 'lock.awaiting-fee', detail: `${transfer.id} ${ev.amount.value} ${token.sym} from ${ev.from}, fee due ${transfer.feeXrp} XRP (tx ${ev.tx.slice(0, 8)})` }
  return completeLock(s, transfer, token, now)
}

/**
 * The lock and its fee are both in, whichever came last: mint, or turn both away. The caps are checked here, when the
 * mint is decided — which is when the fee attaches, not when the lock lands.
 */
function completeLock(s: State, transfer: TransferRec, token: TokenRec, now: number): Applied {
  const amount = transfer.amount
  // Two caps, both the minter's: net units outstanding, and gross units minted in the current UTC day (the minter's bucket, mirrored on consensus time).
  const today = mintedToday(token, now)
  if (dec.gt(amount, MAX_UNITS) || (token.capUnits !== undefined && (dec.gt(dec.add(token.lockedUnits, amount), token.capUnits) || dec.gt(dec.add(today, amount), token.capUnits)))) {
    transfer.failed = 'cap'
    const refund = queueReturn(s, 'lock', { tx: transfer.srcTx!, from: transfer.lockFrom! }, releaseAmount(token, amount), now)
    if (refund) transfer.refundActionId = refund.id
    // Nothing was bridged, so the fee goes back as well — to the account the intent named, which is the only one whose
    // payment could have attached: the memo is public, and a stranger's lock must not redirect someone else's fee.
    const feeBack = queueReturn(s, 'funding', { tx: transfer.feeTx!, from: transfer.from }, { currency: 'XRP', value: transfer.feeXrp! }, now)
    if (feeBack) transfer.refundActionId ??= feeBack.id
    else keepXrp(s, transfer.feeXrp!, token.sym)
    return { kind: 'lock.failed', detail: `${transfer.id} ${amount} ${token.sym} over cap ${token.capUnits} (today ${today}); ${refund ? `refund ${refund.id} queued` : 'nothing to refund'}; fee ${feeBack ? `${feeBack.id} returned` : 'kept (below the fee)'}` }
  }
  transfer.receive = amount
  transfer.step = 3
  transfer.sigs = 0
  token.lockedUnits = dec.add(token.lockedUnits, amount)
  token.mintedToday = dec.add(today, amount)
  keepXrp(s, transfer.feeXrp!, token.sym)
  return { kind: 'lock', detail: `${transfer.id} ${amount} ${token.sym} from ${transfer.lockFrom} → ${transfer.to} fee ${transfer.feeXrp} XRP (tx ${transfer.srcTx!.slice(0, 8)})` }
}

// ---------------------------------------------------------------- funding

/** The memo an intent's XRP fee payment carries. Authored here, parsed here: one owner for the format. */
export function feeMemoOf(intentId: string): string {
  return `blume:fee:${intentId}`
}

const FEE_MEMO = new RegExp(`^blume:fee:(${INTENT_ID_SRC})$`, 'i')

type FundingKind = { kind: 'fee'; intentId: string } | { kind: 'return'; lockTx: string | null } | { kind: 'retired' } | { kind: 'proposal'; spec: string } | { kind: 'meta'; spec: string } | { kind: 'bad' }

/** `return:<lock tx>`: a lock's sender asking for it back. A hash is 64 hex characters, written upper case on the ledger. */
const RETURN_MEMO = /^return:([0-9A-Fa-f]{64})$/

/**
 * What a payment to the funding account is for, by its memo. The one classifier: it decides both the order events apply
 * in and how each is handled, so the two can never drift apart.
 */
function classifyFunding(ev: XrplPaymentEvent): FundingKind {
  const m = (ev.memo ?? '').trim()
  const fee = FEE_MEMO.exec(m)
  if (fee) return { kind: 'fee', intentId: fee[1].toLowerCase() }
  if (/^return:/i.test(m)) return { kind: 'return', lockTx: RETURN_MEMO.exec(m)?.[1].toUpperCase() ?? null }
  // Funding rounds are gone. A payment still aimed at one is not silently kept.
  if (/^round:/i.test(m)) return { kind: 'retired' }
  if (/^propose:/i.test(m)) return { kind: 'proposal', spec: m.slice(8) }
  if (/^meta:/i.test(m)) return { kind: 'meta', spec: m.slice(5) }
  return { kind: 'bad' }
}

function applyFunding(s: State, ev: XrplPaymentEvent, now: number): Applied[] {
  const memo = classifyFunding(ev)
  // A fee or a return goes to its own handler whatever it was paid in, so an IOU carrying one of those memos goes back like every other payment the cluster cannot use.
  if (memo.kind === 'fee') return applyFee(s, ev, memo.intentId, now)
  if (memo.kind === 'return') return [applyReturn(s, ev, memo.lockTx, now)]
  if (ev.amount.currency !== 'XRP') return [unmatched(s, ev, 'not-xrp')]
  if (memo.kind === 'retired') return [sendBack(s, ev, 'round:retired', now, 'round.retired')]
  if (memo.kind === 'proposal') return [applyProposal(s, ev, memo.spec, now)]
  if (memo.kind === 'meta') return [applyMeta(s, ev, memo.spec, now)]
  return [unmatched(s, ev, 'bad-memo')]
}

/**
 * A payment to the funding account the cluster cannot use: recorded, and sent back less the fee the return costs. When
 * the return would cost more than the payment carries, the XRP stays, and is booked as the revenue it now is.
 */
function sendBack(s: State, ev: XrplPaymentEvent, why: string, now: number, kind: string, sym?: string): Applied {
  unmatched(s, ev, why)
  const action = queueReturn(s, 'funding', ev, ev.amount, now)
  if (!action && ev.amount.currency === 'XRP') keepXrp(s, ev.amount.value, sym)
  return { kind, detail: `${why}: ${ev.amount.value} ${ev.amount.currency} from ${ev.from}; ${action ? `return ${action.id} queued` : 'kept (below the fee)'}` }
}

/**
 * The XRP fee of an inbound intent. It attaches while the intent waits for its lock (one that lapsed waiting for its
 * Batch included: the lock revives it), and to a lock that waits for it, which it completes. From the account the
 * intent named, once, in XRP, for at least what the intent was quoted; anything else goes straight back to whoever paid it.
 */
function applyFee(s: State, ev: XrplPaymentEvent, intentId: string, now: number): Applied[] {
  const t = s.transfers[intentId]
  const reason = feeRejection(s, t, ev)
  if (reason || !t) return [sendBack(s, ev, reason ?? 'fee:no-intent', now, 'fee.returned', t?.sym)]
  t.feeTx = ev.tx
  t.feeXrp = ev.amount.value
  t.updatedAt = now
  const applied: Applied[] = [{ kind: 'fee', detail: `${intentId} ${ev.amount.value} XRP from ${ev.from} (tx ${ev.tx.slice(0, 8)})` }]
  // The lock was here first: this fee is what it was waiting for, and the mint is decided now.
  if (t.step === 2) applied.push(completeLock(s, t, s.tokens[t.sym], now))
  return applied
}

function feeRejection(s: State, t: TransferRec | undefined, ev: XrplPaymentEvent): string | null {
  // The fee is priced in XRP; an IOU with a fee memo is a mistake, and it goes back rather than sitting in the funding account.
  if (ev.amount.currency !== 'XRP') return 'fee:not-xrp'
  if (!t || t.dir !== 'in') return 'fee:no-intent'
  if (t.feeTx) return 'fee:duplicate'
  // An intent that lapsed still takes its fee: the lock of the same Batch revives it. A lock waiting for its fee takes it too. Anything else that failed or finished is done with.
  const waitingForLock = t.step === 1 && (t.failed === undefined || t.failed === 'expired')
  const waitingForFee = t.step === 2 && t.failed === undefined
  if (!waitingForLock && !waitingForFee) return 'fee:late'
  // The return on expiry goes to the intent's `from`, so only that account's payment can attach.
  if (ev.from !== t.from) return 'fee:wrong-payer'
  // Against what the intent was quoted, not against params: a params change between the quote and the payment must not underpay an exact one.
  if (!dec.gte(ev.amount.value, t.feeXrp ?? s.config.params.feeXrp)) return 'fee:underpaid'
  // A paused token mints nothing, so a fee that cannot complete its lock goes back and the lock keeps waiting.
  if (s.tokens[t.sym]?.status !== 'listed') return 'fee:token-paused'
  return null
}

/**
 * `return:<lock tx>`: the sender of a lock that never paid its fee asks for it back and pays for the return. Taken when
 * it comes from the lock's own sender, for at least returnFeeXrp, for a lock that is waiting for its fee or that matched
 * no intent. The lock goes back in full (an IOU through the lock account, with the issuer's transfer-fee rules) and the
 * return fee is revenue. Anything else is recorded and the payment goes back.
 */
/** A lock the cap refused whose refund failed on the ledger: nothing is on its way back to the sender. */
export function owedBack(t: TransferRec): boolean {
  return t.failed === 'cap' && t.refundActionId === undefined
}

function applyReturn(s: State, ev: XrplPaymentEvent, lockTx: string | null, now: number): Applied {
  const refuse = (why: string) => sendBack(s, ev, why, now, 'return.refused')
  if (ev.amount.currency !== 'XRP') return refuse('return:not-xrp')
  if (!lockTx) return refuse('return:bad-memo')
  if (!dec.gte(ev.amount.value, s.config.params.returnFeeXrp)) return refuse('return:underpaid')
  const waiting = Object.values(s.transfers).find((t) => t.dir === 'in' && t.srcTx === lockTx)
  const stray = waiting ? undefined : s.unmatched.find((u) => u.tx === lockTx && u.to === s.config.xrpl.lockAccount)
  if (!waiting && !stray) return refuse('return:no-lock')
  const sender = waiting ? waiting.lockFrom : stray!.from
  if (ev.from !== sender) return refuse('return:wrong-sender')
  if (waiting && !(waiting.step === 2 && waiting.failed === undefined) && !owedBack(waiting)) return refuse('return:not-waiting')
  if (stray?.returned) return refuse('return:already-returned')
  const amount: Amount = waiting ? releaseAmount(s.tokens[waiting.sym], waiting.amount) : stray!.amount
  // An IOU can only be paid back while its token is live: a frozen issuer would refuse the payment, and the sender would have paid for nothing.
  const token = findTokenByAmount(s, amount)
  if (amount.currency !== 'XRP' && token?.status !== 'listed') return refuse('return:token-unavailable')
  const back = queueReturn(s, 'lock', { tx: lockTx, from: sender! }, amount, now)
  if (!back) return refuse('return:too-small')
  keepXrp(s, ev.amount.value, token?.sym)
  if (waiting) {
    waiting.failed = 'returned'
    waiting.refundActionId = back.id
    waiting.updatedAt = now
  } else stray!.returned = back.id
  return { kind: 'lock.returned', detail: `${lockTx.slice(0, 8)} ${amount.value} ${amount.currency} back to ${sender} (return fee ${ev.amount.value} XRP; ${back.id})` }
}

/**
 * Whether a new listing opens by itself, decided once, when it is listed: it goes on the minter with no limit and takes
 * deposits as soon as its ERC-20 exists. Only while params.listingsOpen is on, and only for a listing the cluster can
 * vouch for without a person looking:
 *  - an issuer that can still sign, listing its own token: paying is its consent, and what it can still do to its token
 *    is on the token's card;
 *  - an issuer locked for good that owns no ledger objects, whoever pays. One it owns could be a Delegate entry
 *    (XLS-75), through which another account still signs for it: mints more, freezes a line, raises its fee (proven on
 *    Devnet 2026-10-21). A payment from such an account can only have come that way. Ruling a Delegate out for an
 *    issuer that owns something means reading its whole owner directory, which also holds every holder's trust line
 *    (over 11,200 for one day-one coin), so that listing waits for an operator instead.
 */
export function opensByItself(p: Params, byIssuer: boolean, info: IssuerFlags): boolean {
  if (p.listingsOpen !== true) return false
  if (info.blackholed === true) return info.ownerCount === 0
  return byIssuer
}

/** A token goes live: nothing can be locked until the EVM listing executes and sets the real cap, and the lock account opens its trust line. */
function listNow(s: State, token: TokenRec, now: number): void {
  token.listedAt = now
  token.capUnits = '0'
  queueTrustLine(s, token, now)
}

/** How long a refused trust line waits before the cluster tries it again. */
const TRUST_RETRY_MS = 3_600_000

/** tfSetNoRipple: the lock account's side of the line refuses to ripple. */
const TF_SET_NO_RIPPLE = 0x00020000

function queueTrustLine(s: State, token: TokenRec, now: number): void {
  if (token.native || !token.currency) return
  token.trustLine = 'pending'
  // NoRipple is what keeps the backing apart: a token is identified by currency AND issuer, but anyone can mint a
  // token under an existing currency code and list it. Without the flag, a payment can ripple through the lock
  // account from that worthless copy to the real token and leave the lock holding the copy (proven on Devnet,
  // scripts/ripple-check.ts). With it set on every line, no payment can pass through the lock account at all.
  queueAction(s, 'xrpl.trustset', 'lock', { TransactionType: 'TrustSet', Flags: TF_SET_NO_RIPPLE, LimitAmount: { currency: token.currency, issuer: token.issuer, value: token.trustLimit ?? s.config.params.trustLineLimit } }, { kind: 'trustline', sym: token.sym }, now)
}

/**
 * A token the genesis lists with lane 'genesis' (the mainnet seed list) has no trust line yet: the cluster opens it
 * itself, once, as soon as it knows the lock account's sequence. The test genesis files leave the lane out because
 * their setup script opens the lines with the lock account's master key. Setting a line that is already there is a
 * harmless no-op on the ledger.
 */
function queueTrustLines(s: State, now: number): Applied[] {
  const applied: Applied[] = []
  if (!s.accounts[s.config.xrpl.lockAccount]) return applied
  for (const token of Object.values(s.tokens).sort((a, b) => cmpStr(a.sym, b.sym))) {
    if (token.status !== 'listed' || token.native || !token.currency) continue
    // Never opened by the cluster (the seed list), or opened and refused (the lock account was short of XRP for the reserve, say): that one is tried again, but only once an hour, since a refused multisigned TrustSet still costs its fee.
    const neverOpened = token.lane === 'genesis' && token.trustLine === undefined
    const retry = token.trustLine === 'failed' && now - (token.trustLineFailedAt ?? 0) >= TRUST_RETRY_MS
    if (!neverOpened && !retry) continue
    queueTrustLine(s, token, now)
    applied.push({ kind: 'trustline.queued', detail: `${token.sym} (${token.currency}.${token.issuer.slice(0, 6)})` })
  }
  return applied
}

function issuerListingFee(p: Params): string {
  return p.issuerListingFeeXrp ?? DEFAULT_ISSUER_LISTING_FEE_XRP
}

/** What a refused proposal or metadata change keeps, as fee revenue. Every refusal queues a multisigned return from the funding account, one at a time; at only the network fee a stream of bad memos would hold up payouts and returns for next to nothing. */
const REFUSAL_KEEP_XRP = '1'

/**
 * A proposal or a metadata change the cluster will not take: recorded, and its XRP sent back less REFUSAL_KEEP_XRP
 * (which is fee revenue) and the fee the return costs, so a mistake or a race (someone listed it first) costs one XRP.
 */
function reject(s: State, ev: XrplPaymentEvent, reason: string, now: number): Applied {
  unmatched(s, ev, reason)
  const keep = dec.gt(ev.amount.value, REFUSAL_KEEP_XRP) ? REFUSAL_KEEP_XRP : ev.amount.value
  const back = dec.sub(ev.amount.value, keep)
  const action = dec.gt(back, '0') ? queueReturn(s, 'funding', ev, { ...ev.amount, value: back }, now) : null
  keepXrp(s, action ? keep : ev.amount.value)
  return { kind: 'rejected', detail: `${reason} tx ${ev.tx.slice(0, 8)} ${ev.amount.value} XRP from ${ev.from}; ${action ? `${back} back by ${action.id}, ${keep} kept` : 'too small to return, kept'}` }
}

/**
 * A proposal to list a token, in one of two lanes that cost the same and list at once. Its identity (currency and
 * issuer) comes from the memo and is checked against the ledger: the issuer's account as the feed read it at this
 * window's ledger. The ticker is decoded from the currency, never typed, and the key the listing is stored under is
 * unique even when another issuer has the same ticker.
 *
 *  - The issuer lane: the issuer's own account pays issuerListingFeeXrp, which is its consent. This is how a token
 *    minted today is bridgeable today.
 *  - The community lane: anyone pays issuerListingFeeXrp, but only for a token whose issuer is locked for good. An
 *    issuer that can still sign has to agree to its token being bridged, by listing it itself.
 *
 * Either way the listing takes deposits once it opens: by itself when opensByItself says so, else when an operator sets
 * its cap. Whatever is refused is sent back.
 */
function applyProposal(s: State, ev: XrplPaymentEvent, spec: string, now: number): Applied {
  const p = s.config.params
  const parsed = parseProposal(spec)
  if (!parsed) return reject(s, ev, 'propose:bad-memo', now)
  const cur = normalizeCurrency(parsed.currency)
  if ('error' in cur) return reject(s, ev, `propose:${cur.error}`, now)
  const { currency, ticker } = cur
  const issuer = parsed.issuer
  if (!issuer || !isValidClassicAddress(issuer)) return reject(s, ev, 'propose:bad-issuer', now)
  if (Object.values(s.tokens).some((t) => t.currency === currency && t.issuer === issuer)) return reject(s, ev, 'propose:exists', now)
  const image = parsed.image ? parseImage(parsed.image) : undefined
  if (image === null) return reject(s, ev, 'propose:bad-image', now)
  const info = ev.issuerFlags
  if (!info) return reject(s, ev, 'propose:issuer-unread', now)
  if (info.clawback) return reject(s, ev, 'propose:clawback', now)
  if (info.requireAuth) return reject(s, ev, 'propose:require-auth', now)
  if (info.globalFreeze) return reject(s, ev, 'propose:global-freeze', now)
  // Without DefaultRipple a holder's trust line will not pass the token on to another holder, so it could never reach the lock account.
  if (!info.defaultRipple) return reject(s, ev, 'propose:no-default-ripple', now)
  const byIssuer = ev.from === issuer
  if (!byIssuer && !info.blackholed) return reject(s, ev, 'propose:needs-issuer', now)
  if (!dec.gte(ev.amount.value, issuerListingFee(p))) return reject(s, ev, 'propose:fee', now)

  const sym = keyFor(s.tokens, ticker, issuer)
  const rate = info.transferRate ?? RATE_ONE
  const opens = opensByItself(p, byIssuer, info)
  // The whole payment is fee revenue, an overpayment included, like any other fee.
  keepXrp(s, ev.amount.value, sym)
  const token: TokenRec = {
    sym,
    ticker,
    name: cleanName(parsed.name, ticker),
    // The issuer's own account named the logo, so it is the coin's. A community listing is by someone who is not the issuer, and a link nobody can check is not put on an ERC-20 for good: an operator sets the logo (admin.ts meta) after looking.
    ...(image && byIssuer ? { image } : {}),
    issuer,
    currency,
    status: 'listed',
    lockedUnits: '0',
    dustUnits: '0',
    noFreezeUnset: canFreeze(info),
    ...(info.blackholed === true ? { issuerLocked: true } : {}),
    lane: byIssuer ? 'issuer' : 'community',
    ...(rate > RATE_ONE ? { transferRate: rate } : {}),
    ...(info.domain ? { domain: info.domain } : {}),
    ...(opens ? { autoOpen: true as const } : {}),
  }
  s.tokens[sym] = token
  listNow(s, token, now)
  return { kind: 'listing', detail: `${sym} ${ticker} (${currency}.${issuer.slice(0, 6)}) listed by ${byIssuer ? 'its issuer' : `${ev.from}, its issuer being locked for good`} for ${ev.amount.value} XRP; trust line queued; ${opens ? 'opens by itself once its ERC-20 lands' : 'waits for an operator to set its cap'}` }
}

/**
 * An issuer changing its token's name or logo: a payment of metaFeeXrp from the issuer's own account with a `meta:`
 * memo. The ERC-20 follows through one signed update (queueEvmWork). A token whose issuer is locked for good keeps what
 * it was listed with.
 */
function applyMeta(s: State, ev: XrplPaymentEvent, spec: string, now: number): Applied {
  const m = parseMeta(spec)
  if (!m) return reject(s, ev, 'meta:bad-memo', now)
  const cur = normalizeCurrency(m.currency)
  const token = 'error' in cur ? undefined : Object.values(s.tokens).find((t) => !t.native && t.currency === cur.currency && t.issuer === ev.from)
  if (!token) return reject(s, ev, 'meta:not-issuer', now)
  if (!dec.gte(ev.amount.value, s.config.params.metaFeeXrp)) return reject(s, ev, 'meta:fee', now)
  const image = m.image === undefined ? token.image : m.image.trim() === '' ? undefined : parseImage(m.image)
  if (image === null) return reject(s, ev, 'meta:bad-image', now)
  const name = m.name === undefined ? token.name : cleanName(m.name, token.ticker ?? token.sym)
  if (name === token.name && image === token.image) return reject(s, ev, 'meta:unchanged', now)
  token.name = name
  if (image) token.image = image
  else delete token.image
  token.metaVersion = (token.metaVersion ?? 0) + 1
  keepXrp(s, ev.amount.value, token.sym)
  return { kind: 'meta', detail: `${token.sym} v${token.metaVersion}: ${JSON.stringify(name)}${image ? ' with a logo' : ' without a logo'} (tx ${ev.tx.slice(0, 8)})` }
}

// ---------------------------------------------------------------- misc

function unmatched(s: State, ev: XrplPaymentEvent, reason: string): Applied {
  s.unmatched.push({ tx: ev.tx, ledger: ev.ledger, from: ev.from, to: ev.to, amount: ev.amount, memo: ev.memo, reason })
  trimUnmatched(s)
  return { kind: 'unmatched', detail: `${reason} tx ${ev.tx.slice(0, 8)} ${ev.amount.value} ${ev.amount.currency} memo=${JSON.stringify(ev.memo)}` }
}

/**
 * The list is capped, and oldest goes first, except for what is still owed: a payment into the lock account that
 * nobody has taken back is how its sender asks for it with `return:`, and it is looked up here. A flood of junk
 * memos must not push such a record out before its sender gets there, so junk goes first and holds only go when
 * the list is full of them.
 */
function trimUnmatched(s: State): void {
  let over = s.unmatched.length - UNMATCHED_CAP
  if (over <= 0) return
  const lock = s.config.xrpl.lockAccount
  const owed = (u: Unmatched) => u.to === lock && u.returned === undefined && !dec.isZero(u.amount.value) && !!findTokenByAmount(s, u.amount)
  const drop = new Set<Unmatched>()
  for (const u of s.unmatched) {
    if (over > 0 && !owed(u)) {
      drop.add(u)
      over--
    }
  }
  for (const u of s.unmatched) {
    if (over > 0 && !drop.has(u)) {
      drop.add(u)
      over--
    }
  }
  s.unmatched = s.unmatched.filter((u) => !drop.has(u))
}

export function isIntentId(id: string): boolean {
  return INTENT_ID.test(id)
}

// ---------------------------------------------------------------- batches

/** A transaction as it goes back in the queue: no sequence or expiry on the outer, no sequence on any inner. Promotion assigns fresh ones. */
function unsequenced(tx: Record<string, unknown>): Record<string, unknown> {
  const out = { ...tx }
  delete out.Sequence
  delete out.LastLedgerSequence
  if (Array.isArray(out.RawTransactions)) {
    out.RawTransactions = rawTransactions(out).map(({ RawTransaction }) => {
      const inner = { ...RawTransaction }
      delete inner.Sequence
      return { RawTransaction: inner }
    })
  }
  return out
}

/**
 * Settles every batch whose outer has validated, at the end of the view that
 * carried the outer. A view is whole ledgers and an inner can only validate in
 * its outer's ledger, so a view that carried the outer carried every inner the
 * ledger applied: the ones still without a result were never applied at all
 * (AllOrNothing discarded them, or Independent never recorded them) and their
 * slots are marked so rather than left open. That makes this view decisive,
 * which is the `outer ledger <= viewTo` test — always true here, since the
 * outer's event reached us in a view no later than this one.
 *
 * The batch is ok only when every inner is: the outer's own tesSUCCESS says
 * nothing about them. The account, held since the outer validated, is released
 * here and nowhere else, which is also what marks a validated batch settled.
 */
function settleBatches(s: State, viewTo: number, now: number): Applied[] {
  const applied: Applied[] = []
  for (const action of Object.values(s.actions)) {
    if (action.kind !== 'xrpl.batch' || action.status !== 'validated') continue
    const rec = s.accounts[accountAddress(s, action.account)]
    if (rec?.inflight !== action.id) continue
    const slots = action.inner ?? []
    for (const slot of slots) if (slot.result === undefined) slot.result = 'unapplied'
    // A batch with no slots to confirm is never a success, whatever the outer said.
    const ok = slots.length > 0 && slots.every((x) => x.result === 'tesSUCCESS')
    action.status = ok ? 'validated' : 'failed'
    action.updatedAt = now
    rec.inflight = undefined
    settle(s, action, ok, now)
    applied.push({ kind: ok ? 'batch.validated' : 'batch.failed', detail: `${action.id} inner ${slots.map((x) => x.result).join(',')} tx ${action.hash?.slice(0, 8)} (view to ${viewTo})` })
  }
  return applied
}
