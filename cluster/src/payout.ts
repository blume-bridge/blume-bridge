import { cmpStr } from './canon'
import * as dec from './dec'
import { queueAction, type Applied } from './machine'
import type { ActionRec, FeesRec, State } from './types'

/**
 * Operator payouts from XRP fees: shares by params.split (operators and
 * treasury), accrued per recipient until they reach the minimum, then one
 * multisigned Batch from the funding account per period, settled per inner
 * payment.
 *
 * The bridge pays its operators in XRP so nobody has to sell the tokens it
 * bridges. Everything here is pure: `now` is consensus time, ordering is
 * cmpStr, amounts are decimal strings.
 */

type PayoutEntry = FeesRec['payouts'][number]
type RecordedShare = PayoutEntry['shares'][number]

/** XLS-56 tfIndependent: an inner payment that fails takes only itself down, not the rest of the batch. */
const TF_INDEPENDENT = 524288
/** XLS-56 tfInnerBatchTxn, required on every inner transaction. */
const TF_INNER_BATCH_TXN = 1073741824
/** Inner transactions a Batch may carry. */
const BATCH_MAX = 8
/** Base reserve plus two owned objects (the signer list and a ticket's worth of headroom). Never paid out. */
const RESERVE_XRP = '1.4'
/** What the XRP Ledger holds back of an account (the same on mainnet, Devnet and Testnet since December 2024): for the account, and for each object it owns. */
const BASE_RESERVE_XRP = '1'
const OWNER_RESERVE_XRP = '0.2'
/** A recipient with nothing accrued yet gets this much before a payment is attempted, so the first one activates the account. */
const DEFAULT_MIN_SHARE_XRP = '1'
/** fees.json is hashed every consensus round, so the history cannot grow without bound. */
const HISTORY_CAP = 100

export interface PayoutShare {
  to: string
  xrp: string
  role: RecordedShare['role']
}

export interface PayoutPlan {
  /** Why nothing would be queued now. Absent means the scheduler would act. */
  blocked?: string
  /** XRP this period has to share out. */
  distributable: string
  /** What the lock account is topped up by before the rest is split; it is the first payment of the batch. '0' when it holds its floor. */
  lockTopUp: string
  /** This period's accruals, by recipient and role, in canonical order. The treasury's kept share is not one of them. */
  accruals: PayoutShare[]
  /** The treasury share that stays with the funding account instead of being paid. */
  kept: string
  /** What each recipient would be owed once the accruals land, in canonical order. */
  owed: { to: string; xrp: string }[]
  /** Who reaches the minimum and would be paid now, in canonical order: the batch's recipients. */
  pay: PayoutShare[]
  /** What `pay` adds up to. */
  totalXrp: string
}

/** a × num / den, rounded down, all three decimal strings. dec.mulRatio only takes integer ratios. */
function scale(a: string, num: string, den: string): string {
  const d = dec.parse(den)
  if (d === 0n) return '0'
  return dec.format((dec.parse(a) * dec.parse(num)) / d)
}

const sum = (xs: string[]) => xs.reduce((acc, x) => dec.add(acc, x), '0')

/** A share the treasury keeps in place: recorded for the history, never paid, so it has no inner transaction. */
const isKept = (sh: RecordedShare) => sh.result === 'kept'

/**
 * XRP that has not been given to anyone yet. Money is in exactly one of four
 * places — paid out, owed to a recipient, sitting in a payout whose shares
 * have not settled, or distributable — so a share can never be handed out
 * twice. Unsettled shares count wherever their action ended up: one that
 * expired and was re-queued under a new id is still money in flight.
 */
function distributableXrp(s: State): string {
  let d = dec.sub(s.fees.xrp, s.fees.paidXrp)
  for (const owed of Object.values(s.fees.owed)) d = dec.sub(d, owed)
  for (const entry of s.fees.payouts) for (const sh of entry.shares) if (sh.result === undefined) d = dec.sub(d, sh.xrp)
  return dec.cmp(d, '0') > 0 ? d : '0'
}

/** True while a payout the cluster has not finished with is holding the funding account's sequence. */
const openPayout = (a: ActionRec) => a.reason.kind === 'payout' && (a.status === 'queued' || a.status === 'pending')

/**
 * XRP the funding account has promised to send back and has not: the returns still queued or pending, with the network
 * fee each costs. It is in the balance, and it is not the bridge's, so a payout never spends it.
 */
function inFlightOut(s: State): string {
  let out = '0'
  for (const a of Object.values(s.actions)) {
    if (a.account !== 'funding' || a.reason.kind === 'payout' || (a.status !== 'queued' && a.status !== 'pending')) continue
    const amount = (a.tx as { Amount?: unknown }).Amount
    // An IOU going back is not XRP; only its fee leaves the funding account.
    if (typeof amount === 'string') out = dec.add(out, dec.fromDrops(amount))
    out = dec.add(out, dec.fromDrops(String(a.tx.Fee)))
  }
  return out
}

/**
 * How much the lock account has to be topped up by, taken out of `available` (this period's fees) before they are split.
 * It keeps `lockFloorXrp` free above its reserve: the base reserve and one owner reserve for its signer list and for each
 * trust line it holds or is about to open. The XRP it holds for users (the XRP token's backing, when XRP is listed) is
 * theirs, not its own. Nothing is read from the ledger beyond the balance every agreed view already carries.
 */
function topUpFor(s: State, available: string): string {
  const floor = s.config.params.payout?.lockFloorXrp
  const rec = s.accounts[s.config.xrpl.lockAccount]
  if (floor === undefined || !rec?.balanceDrops) return '0'
  const lines = Object.values(s.tokens).filter((t) => !t.native && t.currency && t.trustLine !== 'failed').length
  const reserve = dec.add(BASE_RESERVE_XRP, dec.mulRatio(OWNER_RESERVE_XRP, 1 + lines, 1))
  const native = Object.values(s.tokens).find((t) => t.native)
  const owedToUsers = native ? dec.add(native.lockedUnits, native.dustUnits) : '0'
  const own = dec.sub(dec.sub(dec.fromDrops(rec.balanceDrops), reserve), owedToUsers)
  const need = dec.floorToDrops(dec.sub(floor, own))
  if (!dec.gt(need, '0')) return '0'
  return dec.cmp(need, available) > 0 ? dec.floorToDrops(available) : need
}

/**
 * Where an operator's share goes: the address it published, else the cluster's default for operators that could not
 * (params.payout.operatorPayout), else its own key. A node that published nothing registers its own key as its payout
 * address, so "published none" is a payout address equal to the node's key.
 */
export function payoutOf(s: State, o: State['operators'][string]): string {
  const published = o.payoutAddress !== undefined && o.payoutAddress !== o.xrplAddress
  return published ? o.payoutAddress! : (s.config.params.payout?.operatorPayout ?? o.xrplAddress)
}

/** What a payment to this address is for: the treasury's, or an operator's (which includes an old payout address an operator once had). */
function roleOf(s: State, to: string): RecordedShare['role'] {
  if (Object.values(s.operators).some((o) => payoutOf(s, o) === to)) return 'operator'
  return s.config.params.payout?.treasuryAccount === to ? 'treasury' : 'operator'
}

/**
 * What the next payout would look like, without touching the state. The
 * scheduler and the `payouts` read both go through here so the read shows
 * exactly what the cluster is about to do, blocked reason included.
 */
export function computeShares(s: State, now: number): PayoutPlan {
  const distributable = distributableXrp(s)
  const nothing = (blocked: string): PayoutPlan => ({ blocked, distributable, lockTopUp: '0', accruals: [], kept: '0', owed: [], pay: [], totalXrp: '0' })
  const p = s.config.params.payout
  if (!p) return nothing('payouts are off')
  if (Object.keys(s.operators).length < s.config.n) return nothing('the operator set is not complete')
  // A read-only execution carries no consensus timestamp (ctx.timestamp is 0 there), so a countdown from it would be nonsense. Show the preview anyway and let the scheduler, which always runs inside a round, enforce the period.
  const since = now ? now - (s.fees.lastPayoutAt ?? 0) : p.everyMs
  if (since < p.everyMs) return nothing(`the next period opens in ${Math.ceil((p.everyMs - since) / 1000)}s`)
  if (Object.values(s.actions).some(openPayout)) return nothing('a payout is already in flight')
  if (dec.cmp(distributable, p.minXrp) < 0) return nothing(`${distributable} XRP is below the ${p.minXrp} minimum`)

  // The lock account comes first: it is what pays to release and return the tokens, so its XRP is topped up before anyone is paid out of what is left.
  const lockTopUp = topUpFor(s, distributable)
  const split = s.config.params.split
  const opsPool = dec.mulRatio(dec.sub(distributable, lockTopUp), split.operators, 100)
  // Whatever the operators' pool leaves over is the treasury's: percentages that do not divide evenly must not strand XRP.
  let treasury = dec.sub(dec.sub(distributable, lockTopUp), opsPool)
  const accruals: PayoutShare[] = []

  const operators = Object.values(s.operators).sort((a, b) => cmpStr(a.node, b.node))
  const perOperator = dec.floorToDrops(scale(opsPool, '1', String(operators.length)))
  if (dec.gt(perOperator, '0')) for (const o of operators) accruals.push({ to: payoutOf(s, o), xrp: perOperator, role: 'operator' })
  treasury = dec.add(treasury, dec.sub(opsPool, dec.mulRatio(perOperator, operators.length, 1)))

  // Sub-drop dust cannot be paid; leaving it out of every share keeps it distributable next period instead of lost.
  treasury = dec.floorToDrops(treasury)
  const keptInPlace = !p.treasuryAccount || p.treasuryAccount === s.config.xrpl.fundingAccount
  let kept = '0'
  if (dec.gt(treasury, '0')) {
    if (keptInPlace) kept = treasury
    else accruals.push({ to: p.treasuryAccount!, xrp: treasury, role: 'treasury' })
  }

  const owedNow: Record<string, string> = { ...s.fees.owed }
  for (const a of accruals) owedNow[a.to] = dec.add(owedNow[a.to] ?? '0', a.xrp)
  const owed = Object.entries(owedNow)
    .sort(([a], [b]) => cmpStr(a, b))
    .map(([to, xrp]) => ({ to, xrp }))
  // Below the minimum a recipient keeps accruing: the threshold is the account reserve, so the first payment activates an address instead of bouncing off it.
  const minShare = p.minShareXrp ?? DEFAULT_MIN_SHARE_XRP
  // What is owed to the funding account itself is held there: a payment from the account to itself is temREDUNDANT, so it is never paid, and stays owed until something sends it on.
  const shares: PayoutShare[] = owed
    .filter(({ to }) => to !== s.config.xrpl.fundingAccount)
    .map(({ to, xrp }) => ({ to, xrp: dec.floorToDrops(xrp) }))
    .filter(({ xrp }) => dec.gt(xrp, '0') && dec.gte(xrp, minShare))
    .map(({ to, xrp }) => ({ to, xrp, role: roleOf(s, to) }))
  // The lock account's top-up is the batch's first payment, and is not an accrual: it has no minimum and is never owed.
  const pay: PayoutShare[] = dec.gt(lockTopUp, '0') ? [{ to: s.config.xrpl.lockAccount, xrp: lockTopUp, role: 'lock' }, ...shares] : shares
  const totalXrp = sum(pay.map((r) => r.xrp))
  const plan: PayoutPlan = { distributable, lockTopUp, accruals, kept, owed, pay, totalXrp }
  if (!pay.length) return plan

  const rec = s.accounts[s.config.xrpl.fundingAccount]
  if (!rec?.balanceDrops) return { ...plan, blocked: 'the funding balance is unknown' }
  // The treasury's own XRP sits in the same account, and so does what it has promised to send back: neither is the bridge's to pay out.
  // What is held in the account includes this period's own share of it, which is in owedNow but not yet in the state.
  const held = owedNow[s.config.xrpl.fundingAccount] ?? '0'
  const committed = dec.add(dec.add(dec.add(s.treasuryXrp, kept), held), inFlightOut(s))
  const free = dec.sub(dec.sub(dec.fromDrops(rec.balanceDrops), RESERVE_XRP), committed)
  const cost = dec.add(totalXrp, dec.mulRatio(dec.fromDrops(s.config.params.xrplFeeDrops), Math.ceil(pay.length / BATCH_MAX), 1))
  if (dec.cmp(free, cost) < 0) return { ...plan, blocked: `${free} XRP free does not cover ${cost}` }
  return plan
}

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()

/** One inner payment. The memo carries the period so the ledger itself shows which payout a payment belongs to, and whether it is the lock account's top-up. */
function payment(share: PayoutShare, period: number): Record<string, unknown> {
  const type = share.role === 'lock' ? 'blume/topup' : 'blume/payout'
  return { TransactionType: 'Payment', Destination: share.to, Amount: dec.toDrops(share.xrp), Memos: [{ Memo: { MemoType: hex(type), MemoData: hex(String(period)) } }] }
}

/**
 * The outer XLS-56 Batch. Inner transactions carry tfInnerBatchTxn, no fee
 * and no signing key of their own; only the outer is signed, by the cluster.
 * The batch-action unit exports the same shape as batchTx() from machine.ts —
 * this copy keeps payouts standalone until the two meet.
 */
export function buildOuterBatch(account: string, inner: Record<string, unknown>[]): Record<string, unknown> {
  return { TransactionType: 'Batch', Flags: TF_INDEPENDENT, RawTransactions: inner.map((p) => ({ RawTransaction: { ...p, Account: account, Flags: TF_INNER_BATCH_TXN, Fee: '0', SigningPubKey: '' } })) }
}

/** Queues payout batches when a period has elapsed and there is enough to pay. Strictly a no-op otherwise. */
export function schedulePayouts(s: State, now: number): Applied[] {
  const plan = computeShares(s, now)
  if (plan.blocked) return []
  for (const a of plan.accruals) s.fees.owed[a.to] = dec.add(s.fees.owed[a.to] ?? '0', a.xrp)

  let keptShare: RecordedShare | null = null
  if (dec.gt(plan.kept, '0')) {
    // A payment from the funding account to itself is temREDUNDANT and would fail the whole batch at preflight, so the treasury's share simply stays where it is.
    s.treasuryXrp = dec.add(s.treasuryXrp, plan.kept)
    // It has left the distributable pool even though it never left the account; without this it would be shared out again next period.
    s.fees.paidXrp = dec.add(s.fees.paidXrp, plan.kept)
    keptShare = { to: s.config.xrpl.fundingAccount, xrp: plan.kept, role: 'treasury', result: 'kept' }
  }
  // The key goes rather than being set to zero: fees.json carries one per address that ever earned, forever. Sub-drop dust left behind falls back into the pool.
  for (const r of plan.pay) delete s.fees.owed[r.to]

  const applied: Applied[] = []
  for (let i = 0; i < plan.pay.length; i += BATCH_MAX) {
    const chunk = plan.pay.slice(i, i + BATCH_MAX)
    const inner = chunk.map((r) => payment(r, now))
    // A Batch needs two inner transactions; a lone recipient goes out as an ordinary payment under the same reason.
    const action =
      chunk.length === 1
        ? queueAction(s, 'xrpl.payment', 'funding', inner[0], { kind: 'payout', at: now }, now)
        : queueAction(s, 'xrpl.batch', 'funding', buildOuterBatch(s.config.xrpl.fundingAccount, inner), { kind: 'payout', at: now }, now)
    const shares: RecordedShare[] = chunk.map((r) => ({ to: r.to, xrp: r.xrp, role: r.role }))
    // The kept share rides on the first entry: it is part of this period, not of any transaction.
    if (i === 0 && keptShare) shares.push(keptShare)
    const totalXrp = sum(chunk.map((r) => r.xrp))
    s.fees.payouts.push({ actionId: action.id, at: now, totalXrp, shares })
    applied.push({ kind: 'payout.queued', detail: `${action.id} ${action.kind} ${totalXrp} XRP to ${chunk.length} of ${plan.pay.length}` })
  }
  s.fees.lastPayoutAt = now
  trimPayouts(s)
  return applied
}

/** Drops the oldest fully settled entries once the history is over the cap. Anything unsettled stays whatever its age. */
function trimPayouts(s: State): void {
  let over = s.fees.payouts.length - HISTORY_CAP
  if (over <= 0) return
  s.fees.payouts = s.fees.payouts.filter((e) => {
    if (over <= 0 || e.shares.some((sh) => sh.result === undefined)) return true
    over--
    return false
  })
}

/** What a payout action actually pays, in RawTransactions order: destination and amount in drops. */
function paymentsOf(action: ActionRec): { to: string; drops: string }[] {
  const tx = action.tx as { Destination?: string; Amount?: unknown; RawTransactions?: { RawTransaction: { Destination?: string; Amount?: unknown } }[] }
  const rows = tx.RawTransactions ? tx.RawTransactions.map((r) => r.RawTransaction) : [tx]
  return rows.map((r) => ({ to: String(r.Destination ?? ''), drops: String(r.Amount ?? '') }))
}

const fingerprint = (rows: { to: string; drops: string }[]) => rows.map((r) => `${r.to}:${r.drops}`).join(',')

/**
 * The payout this action pays. Normally the id it was queued under; but an
 * action the ledger never showed is re-queued under a new one (expireActions)
 * and nothing relinks a payout to it, so a retry is matched by what it pays —
 * the same period, the same recipients, the same drops, nothing settled yet.
 */
function entryFor(s: State, action: ActionRec): PayoutEntry | undefined {
  const byId = s.fees.payouts.find((e) => e.actionId === action.id)
  if (byId || action.reason.kind !== 'payout') return byId
  const want = fingerprint(paymentsOf(action))
  const at = action.reason.at
  const match = s.fees.payouts.find((e) => {
    const payments = e.shares.filter((sh) => !isKept(sh))
    return e.at === at && payments.length > 0 && payments.every((sh) => sh.result === undefined) && fingerprint(payments.map((sh) => ({ to: sh.to, drops: dec.toDrops(sh.xrp) }))) === want
  })
  if (match) match.actionId = action.id
  return match
}

/** Records the outcome of a payout batch, share by share, from its inner results. */
export function settlePayout(s: State, action: ActionRec, _now: number): void {
  if (action.reason.kind !== 'payout') return
  // The outer Batch is tesSUCCESS even when its inner payments failed, so a batch is settled by its slots and never by its own result. Until they are filled, a batch that validated has not been settled at all.
  if (action.kind === 'xrpl.batch' && action.status === 'validated' && !(action.inner ?? []).some((x) => x.result !== undefined)) return
  const entry = entryFor(s, action)
  if (!entry) return
  // Indexes line up with RawTransactions because only the kept share is filtered out, and it is always last.
  const payments = entry.shares.filter((sh) => !isKept(sh))
  let settled = 0
  for (let i = 0; i < payments.length; i++) {
    const sh = payments[i]
    if (sh.result !== undefined) continue
    // A lone recipient went out as a plain payment, so the action's own outcome is that share's.
    const slot = action.inner ? action.inner[i] : { hash: action.hash, result: action.result }
    if (slot?.result === 'tesSUCCESS') {
      sh.result = slot.result
      sh.hash = slot.hash
      s.fees.paidXrp = dec.add(s.fees.paidXrp, sh.xrp)
    } else {
      // A tec, a batch that never applied, or a slot the ledger never filled: the recipient is owed it again and it goes out with the next period.
      sh.result = slot?.result ?? 'unapplied'
      if (slot?.hash) sh.hash = slot.hash
      // The lock account is owed nothing: a refused top-up falls back into the pool, and the next period works out what it needs then.
      if (sh.role !== 'lock') s.fees.owed[sh.to] = dec.add(s.fees.owed[sh.to] ?? '0', sh.xrp)
    }
    settled++
  }
  if (!settled) return
  // The account paid the transaction fee whatever the inner payments did.
  s.fees.paidXrp = dec.add(s.fees.paidXrp, dec.fromDrops(s.config.params.xrplFeeDrops))
}
