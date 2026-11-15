import { describe, expect, it } from 'vitest'
import { toTransfer } from '../src/api'
import { canon, cmpStr } from '../src/canon'
import { UNMATCHED_CAP, applyView, createIntent, feeMemoOf, owedBack, queueEvmWork, tick, validateIntent } from '../src/machine'
import type { State, Unmatched, XrplPaymentEvent } from '../src/types'
import genesis from '../genesis/dev.json'
import { ALICE, BOB, EVM, FUND, LOCK, NOW, accounts, baseState, feeOf, hashOf64, intent, lockOf, outgoing, pay, petal, view, xrp } from './helpers'

/**
 * The inbound fee: an intent pays what it was quoted, in XRP, to the funding
 * account (memo blume:fee:<id>) before its lock or in the same Batch, and the
 * lock mints the full amount. Also the view ordering that makes a Batch resolve
 * whatever its inner hashes are, and what becomes of a fee nothing can use.
 */

const TTL = genesis.config.intentTtlMs
// Anyone may list a token whose issuer is locked for good; an issuer that can still sign lists its own token.
const okFlags = { noFreeze: true, globalFreeze: false, requireAuth: false, clawback: false, defaultRipple: true, disableMaster: true, blackholed: true }
/** MOO's issuer: not BOB, who proposes it, so the listing is a community one. */
const MOO_ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'

const base = baseState
const returns = (s: State) => Object.values(s.actions).filter((a) => a.reason.kind === 'return')
const returnFor = (s: State, tx: string) => returns(s).find((a) => (a.reason as { tx: string }).tx === tx)
/** What the events did, without the promotions the view's account snapshot triggers afterwards. */
const kinds = (applied: { kind: string }[]) => applied.map((a) => a.kind).filter((k) => k !== 'action.pending')

describe('intents', () => {
  it('refuses the token fee that no longer exists, and takes the XRP one or none', () => {
    const s = base()
    const req = { dir: 'in', sym: 'PETAL', amount: '1', from: ALICE, to: EVM }
    expect(validateIntent(s, { ...req, fee: 'token' })).toEqual({ ok: false, error: 'the token fee no longer exists' })
    expect(validateIntent(s, { ...req, fee: 'gold' })).toEqual({ ok: false, error: 'fee must be xrp' })
    expect(validateIntent(s, { ...req, fee: 'xrp' }).ok).toBe(true)
    expect(validateIntent(s, { ...req, fee: null }).ok).toBe(true)
    expect(validateIntent(s, req).ok).toBe(true)
    // the XRP fee is for bridging in
    expect(validateIntent(s, { dir: 'out', sym: 'PETAL', amount: '1', from: EVM, to: ALICE, fee: 'xrp' })).toEqual({ ok: false, error: 'the XRP fee is for inbound transfers' })
    expect(validateIntent(s, { dir: 'out', sym: 'PETAL', amount: '1', from: EVM, to: ALICE }).ok).toBe(true)
  })
  it('an inbound intent expects the full amount and pins the fee it was quoted', () => {
    const s = base()
    const x = intent(s).transfer
    expect(x.receive).toBe('1000')
    expect(x.feeXrp).toBe(genesis.config.params.feeXrp)
    // an outbound one has no fee to pin: the exit fee is paid on the EVM side
    const out = validateIntent(s, { dir: 'out', sym: 'PETAL', amount: '1', from: EVM, to: ALICE })
    if (!out.ok) throw new Error(out.error)
    const o = createIntent(s, out.intent, 'feefeefeefeefee2', NOW).transfer
    expect(o.receive).toBe('1')
    expect(o.feeXrp).toBeUndefined()
  })
  it('the quoted fee is what the payment is judged against, whatever params say later', () => {
    const { state: quoted, transfer } = intent(base())
    // the operators raise the fee after the quote; a payment of exactly what was quoted is still in full
    const raised = { ...quoted, config: { ...quoted.config, params: { ...quoted.config.params, feeXrp: '5' } } }
    const { state } = applyView(raised, view(raised, [feeOf(transfer, '1'), lockOf(transfer)]), NOW + 1000)
    expect(state.transfers[transfer.id]).toMatchObject({ step: 3, receive: '1000', feeXrp: '1' })
    expect(state.fees.xrp).toBe('1')
    // and a quote that was higher than params are now is still owed in full
    const dropped = { ...quoted, config: { ...quoted.config, params: { ...quoted.config.params, feeXrp: '0.1' } } }
    const short = applyView(dropped, view(dropped, [feeOf(transfer, '0.1')]), NOW + 1000)
    expect(short.state.unmatched.map((u) => u.reason)).toEqual(['fee:underpaid'])
  })
})

describe('fee and lock', () => {
  it('the fee attaches, then the lock mints the full amount', () => {
    const { state: s, transfer } = intent(base())
    const fee = feeOf(transfer)
    const lock = lockOf(transfer)
    const { state, applied } = applyView(s, view(s, [fee, lock]), NOW + 1000)
    expect(applied.map((a) => a.kind)).toEqual(['fee', 'lock'])
    const t = state.transfers[transfer.id]
    expect(t).toMatchObject({ step: 3, receive: '1000', feeTx: fee.tx, feeXrp: '1', srcTx: lock.tx, lockFrom: ALICE })
    expect(state.tokens.PETAL.lockedUnits).toBe('1000')
    expect(state.tokens.PETAL.mintedToday).toBe('1000')
    expect(state.tokens.PETAL.dustUnits).toBe('0')
    expect(state.fees.xrp).toBe('1')
    expect(state.fees.xrpByToken).toEqual({ PETAL: '1' })
    expect(state.unmatched).toHaveLength(0)
  })
  it('the fee is applied before the lock even when the lock sorts first by hash', () => {
    const { state: s, transfer } = intent(base())
    const lock = lockOf(transfer)
    const fee = feeOf(transfer)
    expect(lock.tx < fee.tx).toBe(true)
    const { state, applied } = applyView(s, view(s, [lock, fee]), NOW + 1000)
    expect(applied.map((a) => a.kind)).toEqual(['fee', 'lock'])
    expect(state.transfers[transfer.id]).toMatchObject({ step: 3, receive: '1000', feeTx: fee.tx })
    expect(state.tokens.PETAL.lockedUnits).toBe('1000')
    expect(state.fees.xrp).toBe('1')
  })
  it('a fee with no intent behind it, an underpaid one, a stranger paying it, a second one and an IOU all go back', () => {
    const { state: s, transfer } = intent(base())
    const orphan = pay(FUND, xrp('1'), 'blume:fee:0123456789abcdef')
    const short = feeOf(transfer, '0.5')
    const stranger = feeOf(transfer, '1', { from: BOB })
    const iou = pay(FUND, petal('5'), feeMemoOf(transfer.id))
    const good = feeOf(transfer)
    const twice = feeOf(transfer)
    const { state, applied } = applyView(s, view(s, [orphan, short, stranger, iou, good, twice]), NOW + 1000)
    expect(kinds(applied)).toEqual(['fee.returned', 'fee.returned', 'fee.returned', 'fee.returned', 'fee', 'fee.returned'])
    expect(state.unmatched.map((u) => u.reason)).toEqual(['fee:no-intent', 'fee:underpaid', 'fee:wrong-payer', 'fee:not-xrp', 'fee:duplicate'])
    expect(state.transfers[transfer.id]).toMatchObject({ step: 1, feeTx: good.tx, feeXrp: '1' })
    const back = returns(state)
    expect(back.map((a) => (a.reason as any).tx)).toEqual([orphan.tx, short.tx, stranger.tx, iou.tx, twice.tx])
    expect(back.map((a) => (a.tx as any).Destination)).toEqual([ALICE, ALICE, BOB, ALICE, ALICE])
    // XRP goes back less the fee the funding account pays to send it; an IOU goes back whole
    expect(back.map((a) => (a.tx as any).Amount)).toEqual(['999000', '499000', '999000', petal('5'), '999000'])
    expect(back.every((a) => a.account === 'funding')).toBe(true)
    expect(state.fees.xrp).toBe('0')
  })
  it('a fee too small to send back is kept and booked, so the account and the fee ledger agree', () => {
    const { state: s, transfer } = intent(base())
    // both are at or under the 1000-drop fee the return would itself cost
    const orphan = pay(FUND, xrp('0.0005'), 'blume:fee:0123456789abcdef')
    const dust = feeOf(transfer, '0.001')
    const { state } = applyView(s, view(s, [orphan, dust]), NOW + 1000)
    expect(returns(state)).toHaveLength(0)
    expect(state.unmatched.map((u) => u.reason)).toEqual(['fee:no-intent', 'fee:underpaid'])
    expect(state.fees.xrp).toBe('0.0015')
    // only the one whose intent named a token counts against that token
    expect(state.fees.xrpByToken).toEqual({ PETAL: '0.001' })
  })
  it('an overpaid fee is kept whole and counted', () => {
    const { state: s, transfer } = intent(base())
    const { state } = applyView(s, view(s, [feeOf(transfer, '1.5'), lockOf(transfer)]), NOW + 1000)
    expect(state.transfers[transfer.id]).toMatchObject({ step: 3, receive: '1000', feeXrp: '1.5' })
    expect(state.fees.xrp).toBe('1.5')
    expect(state.fees.xrpByToken.PETAL).toBe('1.5')
  })
  it('adds up across tokens', () => {
    const a = intent(base(), { id: 'feefeefeefeefee1' })
    const b = intent(a.state, { id: 'feefeefeefeefee2', amount: '500' })
    const c = intent(b.state, { id: 'feefeefeefeefee3', amount: '50', sym: 'XRP' })
    const events = [feeOf(a.transfer), lockOf(a.transfer), feeOf(b.transfer), lockOf(b.transfer, petal('500')), feeOf(c.transfer), lockOf(c.transfer, xrp('50'))]
    const { state } = applyView(c.state, view(c.state, events), NOW + 1000)
    expect(Object.values(state.transfers).map((t) => t.step)).toEqual([3, 3, 3])
    expect(state.tokens.PETAL.lockedUnits).toBe('1500')
    expect(state.tokens.XRP.lockedUnits).toBe('50')
    expect(state.fees.xrp).toBe('3')
    expect(state.fees.xrpByToken).toEqual({ PETAL: '2', XRP: '1' })
  })
})

describe('the cap refusing a lock that paid its fee', () => {
  it('sends the fee back to the account the intent named, not to whoever paid the lock', () => {
    const { state: s, transfer } = intent(base())
    s.tokens.PETAL.capUnits = '500'
    const fee = feeOf(transfer)
    // the lock memo is public: a stranger can pay it, and that must not redirect ALICE's fee
    const lock = lockOf(transfer, petal(), { from: BOB })
    const { state, applied } = applyView(s, view(s, [fee, lock]), NOW + 1000)
    expect(kinds(applied)).toEqual(['fee', 'lock.failed'])
    const t = state.transfers[transfer.id]
    expect(t.failed).toBe('cap')
    expect(state.tokens.PETAL.lockedUnits).toBe('0')
    expect(state.fees.xrp).toBe('0')
    const lockBack = returnFor(state, lock.tx)!
    const feeBack = returnFor(state, fee.tx)!
    expect(t.refundActionId).toBe(lockBack.id)
    expect(lockBack.account).toBe('lock')
    expect((lockBack.tx as any).Destination).toBe(BOB)
    expect(feeBack.account).toBe('funding')
    expect((feeBack.tx as any).Amount).toBe('999000')
    expect((feeBack.tx as any).Destination).toBe(ALICE)
  })
  it('links the fee return whatever the transfer failed of, so a retry follows it and its hash lands', () => {
    // an XRP lock of exactly the network fee: nothing is left to send back, so the fee return takes the transfer's one slot
    const { state: s, transfer } = intent(base(), { id: 'feefeefeefeefee4', sym: 'XRP', amount: '0.001' })
    s.tokens.XRP.capUnits = '0'
    const fee = feeOf(transfer)
    const { state, applied } = applyView(s, view(s, [fee, lockOf(transfer, xrp('0.001'))]), NOW + 1000)
    expect(kinds(applied)).toEqual(['fee', 'lock.failed'])
    const t = state.transfers[transfer.id]
    expect(t.failed).toBe('cap')
    const feeBack = returnFor(state, fee.tx)!
    expect(returns(state)).toHaveLength(1)
    expect(t.refundActionId).toBe(feeBack.id)
    // it validates, and settle finds the transfer by the fee tx even though the transfer failed of the cap
    const promoted = applyView(state, view(state, []), NOW + 2000).state
    expect(promoted.actions[feeBack.id]).toMatchObject({ status: 'pending', sequence: 20 })
    const done = applyView(promoted, view(promoted, [{ ...outgoing(FUND, 20), destination: ALICE, amount: xrp('0.999') }], accounts(10, 21)), NOW + 3000).state
    expect(done.actions[feeBack.id].status).toBe('validated')
    expect(done.transfers[transfer.id].refundTx).toMatch(/^OUT/)
  })
})

describe('expiry', () => {
  it('an intent that expires holding a fee is kept, the fee goes back, and the record goes once it has', () => {
    const { state: s, transfer } = intent(base())
    const fee = feeOf(transfer)
    const paid = applyView(s, view(s, [fee]), NOW + 1000).state
    // the clock runs from the fee, not from the intent: a Batch whose fee lands as the intent would lapse is not cut off
    expect(tick(paid, NOW + TTL + 1).state.transfers[transfer.id].failed).toBeUndefined()
    const { state: expired, applied } = tick(paid, NOW + 1000 + TTL + 1)
    const t = expired.transfers[transfer.id]
    expect(t).toMatchObject({ step: 1, failed: 'expired', feeTx: fee.tx })
    expect(applied.map((a) => a.kind)).toEqual(['intent.expired'])
    const ret = expired.actions[t.refundActionId!]
    expect(ret.account).toBe('funding')
    expect(ret.reason).toEqual({ kind: 'return', tx: fee.tx, to: ALICE })
    expect(ret.tx).toMatchObject({ TransactionType: 'Payment', Destination: ALICE, Amount: '999000' })
    expect((ret.tx as any).Memos[0].Memo.MemoData).toBe(Buffer.from(fee.tx, 'utf8').toString('hex').toUpperCase())
    // a client polling the expired intent is not told to pay into it
    expect(toTransfer(expired, t).memo).toBeUndefined()
    // promoted with the funding account's sequence, then validated: the hash lands on the transfer
    const promoted = applyView(expired, view(expired, []), NOW + TTL + 2).state
    expect(promoted.actions[ret.id]).toMatchObject({ status: 'pending', sequence: 20 })
    const done = applyView(promoted, view(promoted, [{ ...outgoing(FUND, 20), destination: ALICE, amount: xrp('0.999') }], accounts(10, 21)), NOW + TTL + 3).state
    expect(done.actions[ret.id].status).toBe('validated')
    expect(done.transfers[transfer.id].refundTx).toMatch(/^OUT/)
    // nothing is owed on it any more, so the record goes and the action stays as the trail
    const swept = tick(done, NOW + TTL + 4)
    expect(swept.state.transfers[transfer.id]).toBeUndefined()
    expect(swept.applied.map((a) => a.kind)).toEqual(['intent.settled'])
    expect(swept.state.actions[ret.id].status).toBe('validated')
  })
  it('a fee return that failed for good also lets the record go', () => {
    const { state: s, transfer } = intent(base())
    const paid = applyView(s, view(s, [feeOf(transfer)]), NOW + 1000).state
    const expired = tick(paid, NOW + 1000 + TTL + 1).state
    expired.actions[expired.transfers[transfer.id].refundActionId!].status = 'failed'
    expect(tick(expired, NOW + 2000 + TTL).state.transfers[transfer.id]).toBeUndefined()
  })
  it('a fee too small to send back leaves no record to wait on', () => {
    const off = base()
    off.config = { ...off.config, params: { ...off.config.params, feeXrp: '0.0005' } }
    const { state: s, transfer } = intent(off)
    const paid = applyView(s, view(s, [feeOf(transfer, '0.0005')]), NOW + 1000).state
    const { state, applied } = tick(paid, NOW + 1000 + TTL + 1)
    expect(state.transfers[transfer.id]).toBeUndefined()
    expect(returns(state)).toHaveLength(0)
    expect(applied.map((a) => a.kind)).toEqual(['intent.expired'])
    expect(state.fees.xrp).toBe('0.0005')
    expect(state.fees.xrpByToken).toEqual({ PETAL: '0.0005' })
  })
  it('an inbound intent is kept for the Batch that may still validate; an outbound one is dropped outright', () => {
    const b = intent(base())
    const kept = tick(b.state, NOW + TTL + 1)
    expect(kept.state.transfers[b.transfer.id]).toMatchObject({ step: 1, failed: 'expired' })
    expect(returns(kept.state)).toHaveLength(0)
    // and it is not expired twice
    expect(tick(kept.state, NOW + 2 * TTL).applied).toEqual([])
    const out = validateIntent(base(), { dir: 'out', sym: 'PETAL', amount: '1', from: EVM, to: ALICE })
    if (!out.ok) throw new Error(out.error)
    const o = createIntent(base(), out.intent, 'feefeefeefeefee2', NOW)
    const dropped = tick(o.state, NOW + TTL + 1)
    expect(dropped.state.transfers[o.transfer.id]).toBeUndefined()
    expect(dropped.applied).toEqual([{ kind: 'intent.expired', detail: o.transfer.id }])
  })
  it('a Batch that validates after the lapse revives the intent instead of paying both fees', () => {
    const { state: s, transfer } = intent(base())
    const lapsed = tick(s, NOW + TTL + 1).state
    expect(lapsed.transfers[transfer.id].failed).toBe('expired')
    // the Batch lands both payments in one ledger: the fee attaches, and the lock takes the record back
    const fee = feeOf(transfer)
    const { state, applied } = applyView(lapsed, view(lapsed, [lockOf(transfer), fee]), NOW + TTL + 2)
    expect(applied.map((a) => a.kind)).toEqual(['fee', 'lock'])
    const t = state.transfers[transfer.id]
    expect(t).toMatchObject({ step: 3, receive: '1000', feeTx: fee.tx })
    expect(t.failed).toBeUndefined()
    expect(Object.keys(state.transfers)).toEqual([transfer.id])
    expect(state.tokens.PETAL.lockedUnits).toBe('1000')
    expect(state.tokens.PETAL.dustUnits).toBe('0')
    expect(state.fees.xrp).toBe('1')
    // the revived transfer is payable again, so its memo is back
    expect(toTransfer(state, t).memo).toBe(transfer.memo)
  })
  it('a lock that arrives after the lapse with no fee behind it is recorded and mints nothing', () => {
    const { state: s, transfer } = intent(base())
    const lapsed = tick(s, NOW + TTL + 1).state
    const { state } = applyView(lapsed, view(lapsed, [lockOf(transfer)]), NOW + TTL + 2)
    expect(state.transfers[transfer.id]).toMatchObject({ step: 1, failed: 'expired' })
    expect(state.unmatched.map((u) => u.reason)).toEqual(['intent-closed'])
    expect(Object.keys(state.transfers)).toEqual([transfer.id])
    expect(state.fees.xrp).toBe('0')
  })
  it('an intent whose fee already went back is not revived by a late lock', () => {
    const { state: s, transfer } = intent(base())
    const paid = applyView(s, view(s, [feeOf(transfer)]), NOW + 1000).state
    const expired = tick(paid, NOW + 1000 + TTL + 1).state
    const { state } = applyView(expired, view(expired, [lockOf(transfer)]), NOW + TTL + 2)
    expect(state.transfers[transfer.id]).toMatchObject({ step: 1, failed: 'expired' })
    expect(state.unmatched.map((u) => u.reason)).toEqual(['intent-closed'])
    // a second fee for it is a duplicate, whatever happened to the first
    const again = applyView(state, view(state, [feeOf(transfer)]), NOW + TTL + 3)
    expect(again.state.unmatched.at(-1)?.reason).toBe('fee:duplicate')
  })
  it('keeps at most 200 expired records, dropping the oldest', () => {
    let s = base()
    const ids: string[] = []
    for (let i = 0; i < 205; i++) {
      const id = i.toString(16).padStart(16, '0')
      ids.push(id)
      s = intent(s, { id, amount: '1', now: NOW + i }).state
    }
    const { state, applied } = tick(s, NOW + 205 + TTL + 1)
    const kept = Object.keys(state.transfers).sort()
    expect(kept).toHaveLength(200)
    expect(kept).toEqual(ids.slice(5).sort())
    expect(applied.filter((a) => a.kind === 'intent.dropped')).toHaveLength(5)
  })
})

describe('view order', () => {
  const listing = (extra = {}) => pay(FUND, xrp('50'), `propose:MOO:4D4F4F0000000000000000000000000000000000:${MOO_ISSUER}:Moo`, { issuerFlags: okFlags, from: BOB, ...extra })
  it('within one ledger: outgoing, then fees, then proposals, then the rest, then returns', () => {
    const { state: s, transfer } = intent(base())
    // created in this order, so their hashes rise in this order: the opposite of the order they apply in
    const strayReturn = pay(FUND, xrp('0.25'), `return:${hashOf64(0x51)}`)
    const lock = lockOf(transfer)
    const proposal = listing()
    const retired = pay(FUND, xrp('10'), 'round:MOO')
    const fee = feeOf(transfer)
    const out = outgoing(FUND, 40, 'tesSUCCESS', 'Payment', { ledger: 102 })
    const { applied } = applyView(s, view(s, [strayReturn, lock, proposal, retired, fee, out]), NOW)
    expect(kinds(applied)).toEqual(['outgoing.unmatched', 'fee', 'listing', 'lock', 'round.retired', 'return.refused'])
  })
  it('the ledger wins across ledgers: a lock that comes ahead of its fee waits for it, and nothing is applied before what the ledger put first', () => {
    const { state: s, transfer } = intent(base())
    // a fee that only lands four ledgers after its lock, and a listing that lands before either
    const lock = lockOf(transfer, petal(), { ledger: 102 })
    const proposal = listing({ ledger: 101 })
    const fee = feeOf(transfer, '1', { ledger: 104 })
    const { state, applied } = applyView(s, view(s, [fee, lock, proposal]), NOW)
    expect(kinds(applied)).toEqual(['listing', 'lock.awaiting-fee', 'fee', 'lock'])
    expect(state.transfers[transfer.id]).toMatchObject({ step: 3, receive: '1000', feeTx: fee.tx })
    expect(state.tokens.PETAL.lockedUnits).toBe('1000')
    expect(state.fees.xrp).toBe('51')
  })
})

/** A lock that came in without its fee: the intent, and the lock with the 64-hex hash a `return:` memo names. */
function waiting(opts: { id?: string; amount?: string; sym?: string; lockedBy?: string; n?: number } = {}) {
  const sym = opts.sym ?? 'PETAL'
  const i = intent(base(), { id: opts.id, amount: opts.amount ?? '1000', sym })
  const amount = sym === 'XRP' ? xrp(opts.amount ?? '1000') : petal(opts.amount ?? '1000')
  const lock = lockOf(i.transfer, amount, { tx: hashOf64(opts.n ?? 0xa11), ...(opts.lockedBy ? { from: opts.lockedBy } : {}) })
  const r = applyView(i.state, view(i.state, [lock]), NOW + 1000)
  return { state: r.state, transfer: r.state.transfers[i.transfer.id], lock, applied: r.applied }
}
const returnPayment = (lockTx: string, value = '0.25', extra: Partial<XrplPaymentEvent> = {}) => pay(FUND, xrp(value), `return:${lockTx}`, extra)

describe('a lock without its fee', () => {
  it('waits: nothing mints, lockedUnits does not move, nothing is sent back, and the read says what is owed', () => {
    const { state, transfer, lock, applied } = waiting()
    expect(kinds(applied)).toEqual(['lock.awaiting-fee'])
    expect(transfer).toMatchObject({ step: 2, srcTx: lock.tx, lockFrom: ALICE, amount: '1000', receive: '1000' })
    expect(transfer.failed).toBeUndefined()
    expect(state.tokens.PETAL.lockedUnits).toBe('0')
    expect(state.tokens.PETAL.mintedToday).toBeUndefined()
    expect(state.fees.xrp).toBe('0')
    expect(Object.keys(state.actions)).toHaveLength(0)
    expect(state.unmatched).toHaveLength(0)
    const read = toTransfer(state, transfer)
    expect(read.awaitingFee).toEqual({ feeTo: FUND, feeMemo: feeMemoOf(transfer.id), feeXrp: '1', returnMemo: `return:${lock.tx}`, returnFeeXrp: '0.25' })
    expect(read.feeTx).toBeUndefined()
    // and the mint is not queued: the EVM side sees nothing to do
    expect(queueEvmWork(state, NOW + 2000)).toHaveLength(0)
  })
  it('does not expire, however long it waits, and is not pruned', () => {
    const { state, transfer } = waiting()
    let s = state
    for (const t of [NOW + TTL + 1, NOW + 100 * TTL, NOW + 10_000 * TTL]) s = tick(s, t).state
    expect(s.transfers[transfer.id]).toMatchObject({ step: 2 })
    expect(s.transfers[transfer.id].failed).toBeUndefined()
    expect(Object.keys(s.actions)).toHaveLength(0)
    expect(s.tokens.PETAL.lockedUnits).toBe('0')
  })
  it('is completed by a late fee, in a later view or a later round, and mints the full amount', () => {
    const { state, transfer } = waiting()
    const fee = feeOf(transfer)
    const done = applyView(state, view(state, [fee]), NOW + 5000)
    expect(kinds(done.applied)).toEqual(['fee', 'lock'])
    expect(done.state.transfers[transfer.id]).toMatchObject({ step: 3, receive: '1000', feeTx: fee.tx, feeXrp: '1' })
    expect(done.state.tokens.PETAL.lockedUnits).toBe('1000')
    expect(done.state.tokens.PETAL.mintedToday).toBe('1000')
    expect(done.state.fees.xrp).toBe('1')
    expect(done.state.fees.xrpByToken).toEqual({ PETAL: '1' })
    expect(toTransfer(done.state, done.state.transfers[transfer.id]).awaitingFee).toBeUndefined()
    // far later, the same: nothing about waiting makes the fee less welcome
    const much = applyView(state, view(state, [feeOf(transfer, '2')]), NOW + 90 * 86_400_000)
    expect(much.state.transfers[transfer.id]).toMatchObject({ step: 3, feeXrp: '2' })
    expect(much.state.fees.xrp).toBe('2')
  })
  it('judges a late fee as it judges any other: underpaid, a stranger paying it, a second one', () => {
    const { state, transfer } = waiting()
    const short = feeOf(transfer, '0.5')
    const stranger = feeOf(transfer, '1', { from: BOB })
    const good = feeOf(transfer)
    const twice = feeOf(transfer)
    const { state: after } = applyView(state, view(state, [short, stranger, good, twice]), NOW + 5000)
    expect(after.unmatched.map((u) => u.reason)).toEqual(['fee:underpaid', 'fee:wrong-payer', 'fee:duplicate'])
    expect(after.transfers[transfer.id]).toMatchObject({ step: 3, feeTx: good.tx })
    expect(after.fees.xrp).toBe('1')
  })
  it('is turned away with its fee when the cap is full by the time the fee arrives, and was not counted before', () => {
    const { state, transfer, lock } = waiting()
    // the lock landed with room under the cap; by the time its fee comes, another bridge-in has taken it
    const other = intent(state, { id: 'cafecafecafecafe', amount: '400' })
    other.state.tokens.PETAL.capUnits = '1000'
    const taken = applyView(other.state, view(other.state, [feeOf(other.transfer), lockOf(other.transfer, petal('400'))]), NOW + 2000).state
    expect(taken.tokens.PETAL.lockedUnits).toBe('400')
    const fee = feeOf(transfer)
    const { state: late, applied } = applyView(taken, view(taken, [fee]), NOW + 3000)
    expect(kinds(applied)).toEqual(['fee', 'lock.failed'])
    const t = late.transfers[transfer.id]
    expect(t.failed).toBe('cap')
    expect(late.tokens.PETAL.lockedUnits).toBe('400')
    expect(late.fees.xrp).toBe('1')
    // the lock goes back to its sender through the lock account, the fee back to the account the intent named, and only the one fee of the other bridge-in is revenue
    const lockBack = returnFor(late, lock.tx)!
    const feeBack = returnFor(late, fee.tx)!
    expect(lockBack.account).toBe('lock')
    expect((lockBack.tx as any).Destination).toBe(ALICE)
    expect((lockBack.tx as any).Amount).toEqual(petal())
    expect(feeBack.account).toBe('funding')
    expect((feeBack.tx as any).Amount).toBe('999000')
    expect(t.refundActionId).toBe(lockBack.id)
  })
  it('checks the cap when the fee attaches, not when the lock lands: a lock over the cap still waits', () => {
    const i = intent(base())
    i.state.tokens.PETAL.capUnits = '500'
    const lock = lockOf(i.transfer, petal(), { tx: hashOf64(7) })
    const { state, applied } = applyView(i.state, view(i.state, [lock]), NOW + 1000)
    expect(kinds(applied)).toEqual(['lock.awaiting-fee'])
    expect(state.transfers[i.transfer.id]).toMatchObject({ step: 2 })
    expect(Object.keys(state.actions)).toHaveLength(0)
    // raise the cap before the fee comes and the lock mints
    state.tokens.PETAL.capUnits = '5000'
    const done = applyView(state, view(state, [feeOf(i.transfer)]), NOW + 2000).state
    expect(done.transfers[i.transfer.id]).toMatchObject({ step: 3 })
    expect(done.tokens.PETAL.lockedUnits).toBe('1000')
  })
  it('a fee for a token that is paused goes back and the lock keeps waiting', () => {
    const { state, transfer } = waiting()
    state.tokens.PETAL.status = 'paused'
    const fee = feeOf(transfer)
    const { state: after, applied } = applyView(state, view(state, [fee]), NOW + 5000)
    expect(kinds(applied)).toEqual(['fee.returned'])
    expect(after.unmatched.map((u) => u.reason)).toEqual(['fee:token-paused'])
    expect(after.transfers[transfer.id]).toMatchObject({ step: 2 })
    expect(after.transfers[transfer.id].feeTx).toBeUndefined()
    expect(returnFor(after, fee.tx)).toBeDefined()
    expect(after.fees.xrp).toBe('0')
  })
  it('a fee arriving for a finished transfer is late and goes back', () => {
    const { state, transfer } = waiting()
    const done = applyView(state, view(state, [feeOf(transfer)]), NOW + 5000).state
    const late = feeOf(transfer)
    const { state: after } = applyView(done, view(done, [late]), NOW + 6000)
    // a second fee for a minted transfer is a duplicate; for a returned one, it is late
    expect(after.unmatched.at(-1)?.reason).toBe('fee:duplicate')
    const ret = waiting({ id: 'dddddddddddddddd', n: 0xd00d })
    const gone = applyView(ret.state, view(ret.state, [returnPayment(ret.lock.tx)]), NOW + 5000).state
    expect(gone.transfers[ret.transfer.id].failed).toBe('returned')
    const tooLate = feeOf(ret.transfer)
    const { state: after2 } = applyView(gone, view(gone, [tooLate]), NOW + 6000)
    expect(after2.unmatched.at(-1)?.reason).toBe('fee:late')
    expect(returnFor(after2, tooLate.tx)).toBeDefined()
  })
  it('a lock that names no live intent is recorded, not minted: a bare 0x memo, an unknown id, a closed intent, a second lock, another token than the intent\'s', () => {
    const i = intent(base())
    const minted = applyView(i.state, view(i.state, [feeOf(i.transfer), lockOf(i.transfer)]), NOW + 1000).state
    const second = lockOf(i.transfer, petal('5'), { tx: hashOf64(2) })
    const unknownId = pay(LOCK, petal('6'), `blume:0123456789abcdef:${EVM}`, { tx: hashOf64(3) })
    const bare = pay(LOCK, petal('7'), EVM, { tx: hashOf64(4) })
    const wrongToken = pay(LOCK, xrp('8'), i.transfer.memo!, { tx: hashOf64(5) })
    const { state } = applyView(minted, view(minted, [second, unknownId, bare, wrongToken]), NOW + 2000)
    expect(state.unmatched.map((u) => u.reason)).toEqual(['intent-closed', 'no-intent', 'no-intent', 'no-intent'])
    expect(state.tokens.PETAL.lockedUnits).toBe('1000')
    expect(Object.keys(state.transfers)).toEqual([i.transfer.id])
  })
})

describe('return:', () => {
  it('sends the lock back in full to its sender; the return fee is revenue and the transfer ends returned', () => {
    const { state, transfer, lock } = waiting()
    const ret = returnPayment(lock.tx)
    const { state: after, applied } = applyView(state, view(state, [ret]), NOW + 5000)
    expect(kinds(applied)).toEqual(['lock.returned'])
    const t = after.transfers[transfer.id]
    expect(t.failed).toBe('returned')
    expect(after.tokens.PETAL.lockedUnits).toBe('0')
    // 0.25 XRP, kept whole
    expect(after.fees.xrp).toBe('0.25')
    expect(after.fees.xrpByToken).toEqual({ PETAL: '0.25' })
    const back = after.actions[t.refundActionId!]
    expect(back.account).toBe('lock')
    expect(back.reason).toEqual({ kind: 'return', tx: lock.tx, to: ALICE })
    expect(back.tx).toMatchObject({ TransactionType: 'Payment', Destination: ALICE, Amount: petal() })
    // nothing is left to wait for, and a client polling the transfer is not told to pay a fee
    const read = toTransfer(after, t)
    expect(read.awaitingFee).toBeUndefined()
    expect(read.memo).toBeUndefined()
    // the lock account promotes it and its hash lands on the transfer when the ledger shows it
    const promoted = applyView(after, view(after, []), NOW + 6000).state
    expect(promoted.actions[back.id]).toMatchObject({ status: 'pending', sequence: 10 })
    const done = applyView(promoted, view(promoted, [{ ...outgoing(LOCK, 10), destination: ALICE, amount: petal() }], accounts(11)), NOW + 7000).state
    expect(done.actions[back.id].status).toBe('validated')
    expect(done.transfers[transfer.id].refundTx).toMatch(/^OUT/)
  })
  it('pays the issuer\'s transfer fee out of the lock account, as any return from it does', () => {
    const { state, lock } = waiting()
    state.tokens.PETAL.transferRate = 1_010_000_000
    const { state: after } = applyView(state, view(state, [returnPayment(lock.tx)]), NOW + 5000)
    const back = returnFor(after, lock.tx)!.tx as any
    expect(back.SendMax).toEqual(petal())
    expect(Number(back.Amount.value)).toBeLessThan(1000 / 1.01)
  })
  it('is paid once: a second return for the same lock goes back', () => {
    const { state, transfer, lock } = waiting()
    const first = returnPayment(lock.tx)
    const again = returnPayment(lock.tx)
    const { state: after, applied } = applyView(state, view(state, [first, again]), NOW + 5000)
    expect(kinds(applied)).toEqual(['lock.returned', 'return.refused'])
    expect(after.unmatched.map((u) => u.reason)).toEqual(['return:not-waiting'])
    expect(after.fees.xrp).toBe('0.25')
    expect(Object.values(after.actions).filter((a) => a.account === 'lock')).toHaveLength(1)
    expect(returnFor(after, again.tx)!.account).toBe('funding')
    expect(after.transfers[transfer.id].failed).toBe('returned')
  })
  it('from anyone but the lock\'s own sender goes back, and the lock keeps waiting', () => {
    const { state, transfer, lock } = waiting()
    const stranger = returnPayment(lock.tx, '0.25', { from: BOB })
    // the account the intent named is not the lock's sender either, when someone else paid the lock
    const { state: after, applied } = applyView(state, view(state, [stranger]), NOW + 5000)
    expect(kinds(applied)).toEqual(['return.refused'])
    expect(after.unmatched.map((u) => u.reason)).toEqual(['return:wrong-sender'])
    expect(after.transfers[transfer.id]).toMatchObject({ step: 2 })
    expect(after.fees.xrp).toBe('0')
    const back = returnFor(after, stranger.tx)!
    expect(back.account).toBe('funding')
    expect(back.tx).toMatchObject({ Destination: BOB, Amount: '249000' })
    // the lock's actual sender is the one who may ask, whoever the intent named
    const paidByBob = waiting({ id: 'bbbbbbbbbbbbbbbb', lockedBy: BOB, n: 0xb0b })
    const theirs = applyView(paidByBob.state, view(paidByBob.state, [returnPayment(paidByBob.lock.tx, '0.25', { from: ALICE })]), NOW + 5000)
    expect(theirs.state.unmatched.map((u) => u.reason)).toEqual(['return:wrong-sender'])
    const mine = applyView(paidByBob.state, view(paidByBob.state, [returnPayment(paidByBob.lock.tx, '0.25', { from: BOB })]), NOW + 5000)
    expect(mine.state.transfers[paidByBob.transfer.id].failed).toBe('returned')
    expect((returnFor(mine.state, paidByBob.lock.tx)!.tx as any).Destination).toBe(BOB)
  })
  it('underpaid goes back, and so does one that names no lock or no hash or is not XRP', () => {
    const { state, transfer, lock } = waiting()
    const short = returnPayment(lock.tx, '0.2')
    const none = returnPayment(hashOf64(0xdead))
    const noHash = pay(FUND, xrp('0.25'), 'return:not-a-hash')
    const iou = pay(FUND, petal('3'), `return:${lock.tx}`)
    const { state: after } = applyView(state, view(state, [short, none, noHash, iou]), NOW + 5000)
    expect(after.unmatched.map((u) => u.reason)).toEqual(['return:underpaid', 'return:no-lock', 'return:bad-memo', 'return:not-xrp'])
    expect(after.transfers[transfer.id]).toMatchObject({ step: 2 })
    expect(after.fees.xrp).toBe('0')
    expect(returns(after).map((a) => (a.tx as any).Amount)).toEqual(['199000', '249000', '249000', petal('3')])
  })
  it('refuses a lock that has minted, one that went back for the cap, and one that is not a lock of ours', () => {
    const i = intent(base())
    const lock = lockOf(i.transfer, petal(), { tx: hashOf64(1) })
    const minted = applyView(i.state, view(i.state, [feeOf(i.transfer), lock]), NOW + 1000).state
    const r = applyView(minted, view(minted, [returnPayment(lock.tx)]), NOW + 2000)
    expect(r.state.unmatched.map((u) => u.reason)).toEqual(['return:not-waiting'])
    expect(r.state.transfers[i.transfer.id]).toMatchObject({ step: 3 })
    expect(r.state.fees.xrp).toBe('1')
  })
  it('takes a lock that matched no intent, keyed by its tx, and only once', () => {
    const s = base()
    const bare = pay(LOCK, petal('250'), EVM, { tx: hashOf64(0xbabe) })
    const { state } = applyView(s, view(s, [bare]), NOW)
    expect(state.unmatched.map((u) => u.reason)).toEqual(['no-intent'])
    const ret = returnPayment(bare.tx)
    const { state: after, applied } = applyView(state, view(state, [ret]), NOW + 1000)
    expect(kinds(applied)).toEqual(['lock.returned'])
    const entry = after.unmatched.find((u) => u.tx === bare.tx)!
    expect(entry.returned).toBeDefined()
    const back = after.actions[entry.returned!]
    expect(back.account).toBe('lock')
    expect(back.tx).toMatchObject({ Destination: ALICE, Amount: petal('250') })
    expect(after.fees.xrp).toBe('0.25')
    // a second ask is refused and its payment goes back
    const twice = returnPayment(bare.tx)
    const { state: again } = applyView(after, view(after, [twice]), NOW + 2000)
    expect(again.unmatched.at(-1)?.reason).toBe('return:already-returned')
    expect(again.fees.xrp).toBe('0.25')
    // a re-queued return (its sequence taken by someone else) is still found by its lock
    const promoted = applyView(after, view(after, []), NOW + 3000).state
    const collided = applyView(promoted, view(promoted, [{ ...outgoing(LOCK, 10, 'tesSUCCESS', 'AccountSet') }], accounts(11)), NOW + 4000).state
    const retry = Object.values(collided.actions).find((a) => a.reason.kind === 'return' && a.status === 'pending')!
    expect(retry.id).not.toBe(entry.returned)
    expect(collided.unmatched.find((u) => u.tx === bare.tx)!.returned).toBe(retry.id)
  })
  it('refuses a stray lock from anyone but its sender, a stray of nothing worth returning, and one of a frozen token', () => {
    const s = base()
    const bare = pay(LOCK, petal('250'), EVM, { tx: hashOf64(0xcafe) })
    const dust = pay(LOCK, petal('250'), EVM, { tx: hashOf64(0xdada) })
    dust.amount = { ...dust.amount, value: '0.00000000000000000001' }
    const { state } = applyView(s, view(s, [bare, dust]), NOW)
    const stranger = returnPayment(bare.tx, '0.25', { from: BOB })
    const dustReturn = returnPayment(dust.tx)
    const { state: second } = applyView(state, view(state, [stranger, dustReturn]), NOW + 1000)
    // the issuer freezes the token: the lock could not be paid back, so its sender is not asked to pay for it
    second.tokens.PETAL.status = 'paused'
    const frozen = returnPayment(bare.tx)
    const { state: after } = applyView(second, view(second, [frozen]), NOW + 2000)
    expect(after.unmatched.slice(2).map((u) => u.reason)).toEqual(['return:wrong-sender', 'return:too-small', 'return:token-unavailable'])
    expect(after.unmatched.find((u) => u.tx === bare.tx)!.returned).toBeUndefined()
    expect(after.fees.xrp).toBe('0')
  })
  it('hands back an XRP lock less the network fee, since the lock account pays to send it', () => {
    const w = waiting({ sym: 'XRP', amount: '50', n: 0x777 })
    const { state } = applyView(w.state, view(w.state, [returnPayment(w.lock.tx)]), NOW + 5000)
    const t = state.transfers[w.transfer.id]
    expect(t.failed).toBe('returned')
    expect(state.actions[t.refundActionId!].tx).toMatchObject({ Destination: ALICE, Amount: '49999000' })
    expect(state.fees.xrp).toBe('0.25')
  })
  it('keeps what a generous sender paid above the return fee', () => {
    const { state, lock } = waiting()
    const { state: after } = applyView(state, view(state, [returnPayment(lock.tx, '3')]), NOW + 5000)
    expect(after.fees.xrp).toBe('3')
  })
  it('is read in the same ledger as the lock it names, after it, whatever the hashes say', () => {
    const i = intent(base())
    const lockHash = hashOf64(0xff)
    const lock = lockOf(i.transfer, petal(), { tx: lockHash })
    // a Batch can carry both: the return sorts before the lock by hash, but a return applies after every lock of its ledger
    const ret = returnPayment(lockHash, '0.25', { tx: hashOf64(1) })
    expect(ret.tx < lock.tx).toBe(true)
    const { state, applied } = applyView(i.state, view(i.state, [ret, lock]), NOW)
    expect(kinds(applied)).toEqual(['lock.awaiting-fee', 'lock.returned'])
    expect(state.transfers[i.transfer.id].failed).toBe('returned')
  })
})

describe('a return the ledger refuses', () => {
  /** The lock account's `return` action for a lock, promoted and then refused by the ledger (a tec: the fee taken, nothing delivered). */
  const refused = (state: State, lockTx: string, to = ALICE, amount = petal()) => {
    const promoted = applyView(state, view(state, []), NOW + 6000).state
    const action = Object.values(promoted.actions).find((a) => a.account === 'lock' && a.reason.kind === 'return' && a.status === 'pending')!
    const done = applyView(promoted, view(promoted, [{ ...outgoing(LOCK, action.sequence!, 'tecPATH_DRY'), destination: to, amount }], accounts(action.sequence! + 1)), NOW + 7000).state
    expect(done.actions[action.id].status).toBe('failed')
    return { state: done, action }
  }
  it('reopens a lock that was waiting: it is waiting for its fee again, and its sender can ask once more', () => {
    const { state, transfer, lock } = waiting()
    const asked = applyView(state, view(state, [returnPayment(lock.tx)]), NOW + 5000).state
    expect(asked.transfers[transfer.id].failed).toBe('returned')
    const { state: after, action } = refused(asked, lock.tx)
    const t = after.transfers[transfer.id]
    expect(t).toMatchObject({ step: 2, srcTx: lock.tx })
    expect(t.failed).toBeUndefined()
    expect(t.refundActionId).toBeUndefined()
    expect(toTransfer(after, t).awaitingFee).toMatchObject({ returnMemo: `return:${lock.tx}` })
    // the return fee stays earned: the cluster did the work
    expect(after.fees.xrp).toBe('0.25')
    // nothing was minted and nothing is owed to the lock's sender but the lock
    expect(after.tokens.PETAL.lockedUnits).toBe('0')
    // the fee can still complete it, or a second ask send it back
    const again = applyView(after, view(after, [returnPayment(lock.tx)]), NOW + 8000)
    expect(kinds(again.applied)).toEqual(['lock.returned'])
    const next = again.state.transfers[transfer.id]
    expect(next.failed).toBe('returned')
    expect(next.refundActionId).not.toBe(action.id)
    expect(again.state.fees.xrp).toBe('0.5')
    const late = applyView(after, view(after, [feeOf(transfer)]), NOW + 8000).state
    expect(late.transfers[transfer.id]).toMatchObject({ step: 3, receive: '1000' })
  })
  it('opens a stray lock to another ask', () => {
    const s = base()
    const bare = pay(LOCK, petal('250'), EVM, { tx: hashOf64(0xbabe) })
    const stray = applyView(s, view(s, [bare]), NOW).state
    const asked = applyView(stray, view(stray, [returnPayment(bare.tx)]), NOW + 1000).state
    expect(asked.unmatched.find((u) => u.tx === bare.tx)!.returned).toBeDefined()
    const { state: after } = refused(asked, bare.tx, ALICE, petal('250'))
    expect(after.unmatched.find((u) => u.tx === bare.tx)!.returned).toBeUndefined()
    const again = applyView(after, view(after, [returnPayment(bare.tx)]), NOW + 8000)
    expect(kinds(again.applied)).toEqual(['lock.returned'])
  })
  it('does the same when it never validated, three times over', () => {
    const { state, transfer, lock } = waiting()
    let cur = applyView(state, view(state, [returnPayment(lock.tx)]), NOW + 5000).state
    for (let n = 0; n < 3; n++) {
      cur = applyView(cur, view(cur, []), NOW + 6000 + n).state
      const open = Object.values(cur.actions).find((a) => a.account === 'lock' && a.reason.kind === 'return' && a.status === 'pending')!
      const far = { ...cur, cursor: { ...cur.cursor, xrpl: { ledger: open.lastLedger! + 1, seen: [] } } }
      cur = applyView(far, view(far, []), NOW + 7000 + n).state
    }
    expect(cur.transfers[transfer.id]).toMatchObject({ step: 2 })
    expect(cur.transfers[transfer.id].failed).toBeUndefined()
    expect(cur.transfers[transfer.id].refundActionId).toBeUndefined()
  })
})

describe('the unmatched list', () => {
  const junk = (n: number): Unmatched => ({ tx: `JUNK${String(n).padStart(4, '0')}`, ledger: 100, from: BOB, to: FUND, amount: xrp('1'), memo: 'junk', reason: 'bad-memo' })
  const garbage = () => pay(FUND, xrp('1'), 'no such memo')

  it('drops junk before a lock that is still owed back, so a flood cannot push the lock out', () => {
    const s = base()
    const bare = pay(LOCK, petal('250'), EVM, { tx: hashOf64(0xbabe) })
    const stray = applyView(s, view(s, [bare]), NOW).state
    stray.unmatched.push(...Array.from({ length: UNMATCHED_CAP - 1 }, (_, n) => junk(n)))
    expect(stray.unmatched).toHaveLength(UNMATCHED_CAP)
    const flood = [garbage(), garbage(), garbage()]
    const { state } = applyView(stray, view(stray, flood), NOW + 1000)
    expect(state.unmatched).toHaveLength(UNMATCHED_CAP)
    // the oldest junk went, three of them, not the lock in front of it
    expect(state.unmatched[0].tx).toBe(bare.tx)
    expect(state.unmatched.some((u) => u.tx === 'JUNK0000' || u.tx === 'JUNK0001' || u.tx === 'JUNK0002')).toBe(false)
    expect(state.unmatched.some((u) => u.tx === 'JUNK0003')).toBe(true)
    expect(state.unmatched.at(-1)!.tx).toBe(flood[2].tx)
    // and its sender can still ask for it back
    const { applied } = applyView(state, view(state, [returnPayment(bare.tx)]), NOW + 2000)
    expect(kinds(applied)).toEqual(['lock.returned'])
  })
  it('counts as junk a lock already taken back, a dust one and one of a token the bridge does not know', () => {
    const s = base()
    const owed = pay(LOCK, petal('250'), EVM, { tx: hashOf64(1) })
    const taken = pay(LOCK, petal('3'), EVM, { tx: hashOf64(2) })
    const dust = pay(LOCK, petal('3'), EVM, { tx: hashOf64(3) })
    dust.amount = { ...dust.amount, value: '0.00000000000000000001' }
    const foreign = pay(LOCK, { currency: 'ZZZ', issuer: BOB, value: '9' }, EVM, { tx: hashOf64(4) })
    const stray = applyView(s, view(s, [owed, taken, dust, foreign]), NOW).state
    stray.unmatched.find((u) => u.tx === taken.tx)!.returned = 'someaction'
    stray.unmatched.push(...Array.from({ length: UNMATCHED_CAP - stray.unmatched.length }, (_, n) => junk(n)))
    const { state } = applyView(stray, view(stray, [garbage(), garbage(), garbage()]), NOW + 1000)
    const left = state.unmatched.map((u) => u.tx)
    expect(left).toContain(owed.tx)
    for (const gone of [taken, dust, foreign]) expect(left).not.toContain(gone.tx)
    expect(left).toContain('JUNK0000')
  })
  it('lets the oldest owed lock go only when the whole list is owed locks', () => {
    const s = base()
    const locks = Array.from({ length: UNMATCHED_CAP + 1 }, (_, n) => pay(LOCK, petal('5'), EVM, { tx: hashOf64(n + 1) }))
    const full = applyView(s, view(s, locks), NOW).state
    expect(full.unmatched).toHaveLength(UNMATCHED_CAP)
    expect(full.unmatched.map((u) => u.tx)).toEqual(locks.slice(1).map((l) => l.tx))
  })
})

describe('a lock paid by someone else', () => {
  it('has to bring what was quoted: a dust lock from a stranger does not close the intent', () => {
    const i = intent(base())
    const dust = lockOf(i.transfer, petal('0.000001'), { tx: hashOf64(1), from: BOB })
    const fee = feeOf(i.transfer)
    const { state, applied } = applyView(i.state, view(i.state, [fee, dust]), NOW + 1000)
    expect(kinds(applied)).toEqual(['fee', 'unmatched'])
    expect(state.unmatched.map((u) => u.reason)).toEqual(['intent-underpaid'])
    // still the intent that was paid for, with its fee on it and nothing minted
    expect(state.transfers[i.transfer.id]).toMatchObject({ step: 1, feeTx: fee.tx, amount: '1000' })
    expect(state.transfers[i.transfer.id].failed).toBeUndefined()
    expect(state.tokens.PETAL.lockedUnits).toBe('0')
    // the account the intent named brings whatever it likes and gets it minted
    const own = applyView(state, view(state, [lockOf(i.transfer, petal('7'), { tx: hashOf64(2) })]), NOW + 2000).state
    expect(own.transfers[i.transfer.id]).toMatchObject({ step: 3, amount: '7', receive: '7', lockFrom: ALICE })
    expect(own.tokens.PETAL.lockedUnits).toBe('7')
  })
  it('is taken from a stranger who brings at least the quote, and minted for what they brought', () => {
    const i = intent(base())
    const more = lockOf(i.transfer, petal('1500'), { tx: hashOf64(1), from: BOB })
    const { state } = applyView(i.state, view(i.state, [feeOf(i.transfer), more]), NOW + 1000)
    expect(state.transfers[i.transfer.id]).toMatchObject({ step: 3, amount: '1500', receive: '1500', lockFrom: BOB })
    expect(state.unmatched).toHaveLength(0)
    const exact = intent(base(), { id: 'abababababababab' })
    const same = applyView(exact.state, view(exact.state, [feeOf(exact.transfer), lockOf(exact.transfer, petal('1000'), { from: BOB })]), NOW + 1000).state
    expect(same.transfers[exact.transfer.id]).toMatchObject({ step: 3, amount: '1000', lockFrom: BOB })
  })
  it('is held to the same rule while it waits for its fee', () => {
    const i = intent(base())
    const dust = lockOf(i.transfer, petal('1'), { tx: hashOf64(1), from: BOB })
    const { state } = applyView(i.state, view(i.state, [dust]), NOW + 1000)
    expect(state.unmatched.map((u) => u.reason)).toEqual(['intent-underpaid'])
    expect(state.transfers[i.transfer.id]).toMatchObject({ step: 1 })
    // and a stray that is refused here can be asked back like any other
    const back = applyView(state, view(state, [returnPayment(dust.tx, '0.25', { from: BOB })]), NOW + 2000)
    expect(kinds(back.applied)).toEqual(['lock.returned'])
  })
})

describe('a Batch carrying the fee and the lock', () => {
  const outcome = (feeFirst: boolean) => {
    const i = intent(base())
    const lockTx = hashOf64(feeFirst ? 2 : 1)
    const feeTx = hashOf64(feeFirst ? 1 : 2)
    const events = [lockOf(i.transfer, petal(), { tx: lockTx }), feeOf(i.transfer, '1', { tx: feeTx })]
    const { state, applied } = applyView(i.state, view(i.state, events), NOW + 1000)
    const t = state.transfers[i.transfer.id]
    return { applied: kinds(applied), step: t.step, receive: t.receive, locked: state.tokens.PETAL.lockedUnits, fee: state.fees.xrp, unmatched: state.unmatched.length, actions: Object.keys(state.actions).length }
  }
  it('mints the full amount whichever of the two has the lower hash', () => {
    const a = outcome(true)
    const b = outcome(false)
    expect(a).toEqual(b)
    expect(a).toEqual({ applied: ['fee', 'lock'], step: 3, receive: '1000', locked: '1000', fee: '1', unmatched: 0, actions: 0 })
  })
  it('is the same when the fee lands first, with the lock, or after it', () => {
    const i = intent(base())
    const fee = feeOf(i.transfer, '1', { ledger: 101 })
    const lock = lockOf(i.transfer, petal(), { ledger: 103 })
    const before = applyView(i.state, view(i.state, [fee, lock]), NOW + 1000).state
    const sameLedger = applyView(i.state, view(i.state, [feeOf(i.transfer, '1', { ledger: 103 }), lockOf(i.transfer, petal(), { ledger: 103 })]), NOW + 1000).state
    const after = applyView(i.state, view(i.state, [lockOf(i.transfer, petal(), { ledger: 101 }), feeOf(i.transfer, '1', { ledger: 103 })]), NOW + 1000).state
    for (const s of [before, sameLedger, after]) {
      expect(s.transfers[i.transfer.id]).toMatchObject({ step: 3, receive: '1000' })
      expect(s.tokens.PETAL.lockedUnits).toBe('1000')
      expect(s.fees.xrp).toBe('1')
      expect(s.unmatched).toHaveLength(0)
    }
  })
})

describe('every node computes the same state from the same view', () => {
  it('whatever order the events were collected in: fees, locks, returns, listings, refusals, retired rounds and a top-up in one view', () => {
    const i1 = intent(base(), { id: 'a1a1a1a1a1a1a1a1' })
    const i2 = intent(i1.state, { id: 'a2a2a2a2a2a2a2a2', amount: '30' })
    const i3 = intent(i2.state, { id: 'a3a3a3a3a3a3a3a3', amount: '40' })
    const start = i3.state
    // i3's lock is already waiting for its fee before the view
    const waiting = applyView(start, view(start, [lockOf(i3.transfer, petal('40'), { tx: hashOf64(0x40), ledger: 101 })]), NOW).state
    const events = [
      feeOf(i1.transfer),
      lockOf(i1.transfer),
      lockOf(i2.transfer, petal('30'), { tx: hashOf64(0x30) }),
      feeOf(i3.transfer),
      pay(FUND, xrp('0.25'), `return:${hashOf64(0x30)}`),
      pay(FUND, xrp('50'), `propose:${JSON.stringify({ c: '4D4F4F0000000000000000000000000000000000', i: MOO_ISSUER, n: 'Moo' })}`, { from: BOB, issuerFlags: okFlags }),
      pay(FUND, xrp('5'), 'propose:{"c":', { from: BOB }),
      pay(FUND, xrp('10'), 'round:MOO', { from: BOB }),
      pay(LOCK, xrp('9.4'), '1788912600000', { from: FUND }),
      pay(LOCK, petal('7'), EVM, { tx: hashOf64(0x77) }),
      outgoing(FUND, 40, 'tesSUCCESS', 'Payment', { ledger: 102 }),
    ]
    const run = (order: number[]) => {
      const r = applyView(waiting, view(waiting, order.map((n) => events[n])), NOW + 1000)
      return { state: canon(r.state), kinds: r.applied.map((a) => a.kind) }
    }
    const identity = events.map((_, n) => n)
    const reference = run(identity)
    // reversed, rotated, and a deterministic shuffle
    const orders = [[...identity].reverse(), [...identity.slice(4), ...identity.slice(0, 4)], [3, 9, 1, 6, 0, 10, 5, 2, 8, 4, 7]]
    for (const order of orders) expect(run(order)).toEqual(reference)
    // and it did all of that: two mints, a return, a listing, three things sent back or recorded
    expect(reference.kinds.filter((k) => k === 'lock')).toHaveLength(2)
    expect(reference.kinds).toEqual(expect.arrayContaining(['fee', 'lock.awaiting-fee', 'lock.returned', 'listing', 'rejected', 'round.retired', 'topup.received', 'unmatched', 'outgoing.unmatched']))
  })
})

describe('the open-intent cap', () => {
  const K1 = 'ed' + 'a1'.repeat(32)
  const K2 = 'ed' + 'b2'.repeat(32)
  const ask = (s: State, key: string, from = ALICE) => validateIntent(s, { dir: 'in', sym: 'PETAL', amount: '1', from, to: EVM }, key)
  /** n intents opened by one key, each naming a different `from` unless told otherwise. */
  const opened = (key: string, n: number, froms: string[] = [ALICE]) => {
    let s = base()
    for (let i = 0; i < n; i++) s = intent(s, { id: i.toString(16).padStart(16, '0'), amount: '1', from: froms[i % froms.length], openedBy: key }).state
    return s
  }
  it('holds one user key to 8 open intents', () => {
    expect(ask(opened(K1, 7), K1).ok).toBe(true)
    expect(ask(opened(K1, 8), K1)).toEqual({ ok: false, error: 'you already have 8 open transfers: finish one or wait for it to expire' })
  })
  it('counts the key, not the `from` the caller names', () => {
    // eight different accounts named by one key are still eight intents of that key
    const s = opened(K1, 8, [ALICE, BOB, FUND, LOCK, MOO_ISSUER, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', ALICE, BOB])
    expect(ask(s, K1, 'rpXzhnkZN2JArdmWAk3tmrtJwsErv963Na').ok).toBe(false)
    expect(ask(s, K1, ALICE).ok).toBe(false)
  })
  it('is per key: a second key is not held back by the first', () => {
    const s = opened(K1, 8)
    expect(ask(s, K1).ok).toBe(false)
    expect(ask(s, K2).ok).toBe(true)
    // and the first key's intents say whose they are only while they are open
    expect(Object.values(s.transfers).every((t) => t.openedBy === K1)).toBe(true)
  })
  it('counts only intents that are still open: a lapsed one, one whose lock came, and one that finished free their slot', () => {
    const s = opened(K1, 8)
    expect(ask(s, K1).ok).toBe(false)
    // one intent gets its lock (waiting for its fee): no longer open, and the key goes with it
    const [first] = Object.values(s.transfers).sort((a, b) => cmpStr(a.id, b.id))
    const locked = applyView(s, view(s, [lockOf(first, petal('1'))]), NOW + 1000).state
    expect(locked.transfers[first.id]).toMatchObject({ step: 2 })
    expect(locked.transfers[first.id].openedBy).toBeUndefined()
    expect(ask(locked, K1).ok).toBe(true)
    // the rest lapse: nothing is open
    const lapsed = tick(locked, NOW + TTL + 1).state
    expect(ask(lapsed, K1).ok).toBe(true)
    expect(Object.values(lapsed.transfers).filter((t) => t.failed === 'expired')).toHaveLength(7)
    // a lapsed one is a record kept for its Batch, not an open intent, so 8 more can be opened
    let more = lapsed
    for (let i = 0; i < 8; i++) more = intent(more, { id: (100 + i).toString(16).padStart(16, '0'), amount: '1', openedBy: K1, now: NOW + TTL + 2 }).state
    expect(ask(more, K1).ok).toBe(false)
  })
  it('takes the cap from params.maxOpenIntents', () => {
    const s = opened(K1, 2)
    expect(ask(s, K1).ok).toBe(true)
    const tight = { ...s, config: { ...s.config, params: { ...s.config.params, maxOpenIntents: 2 } } }
    expect(ask(tight, K1)).toMatchObject({ ok: false, error: 'you already have 2 open transfers: finish one or wait for it to expire' })
    const loose = { ...opened(K1, 8), config: { ...base().config, params: { ...base().config.params, maxOpenIntents: 9 } } }
    expect(ask(loose, K1).ok).toBe(true)
  })
  it('is not applied to a request that carries no key', () => {
    const s = opened(K1, 8)
    expect(validateIntent(s, { dir: 'in', sym: 'PETAL', amount: '1', from: ALICE, to: EVM }).ok).toBe(true)
  })
  it('refuses a bad request before it counts anything', () => {
    expect(validateIntent(opened(K1, 8), { dir: 'in', sym: 'NOPE', amount: '1', from: ALICE, to: EVM }, K1)).toEqual({ ok: false, error: 'unknown token NOPE' })
  })
})

describe('what the transfer read shows', () => {
  it('feeTx appears once a fee attaches, before the lock or with it, and not before', () => {
    const i = intent(base())
    expect(toTransfer(i.state, i.transfer).feeTx).toBeUndefined()
    // a fee on its own: the intent is still waiting for its lock, and the read already carries the fee's hash
    const fee = feeOf(i.transfer)
    const paid = applyView(i.state, view(i.state, [fee]), NOW + 1000).state
    expect(toTransfer(paid, paid.transfers[i.transfer.id])).toMatchObject({ step: 1, feeTx: fee.tx })
    expect(toTransfer(paid, paid.transfers[i.transfer.id]).awaitingFee).toBeUndefined()
    // a fee and its lock together
    const both = intent(base(), { id: 'abababababababab' })
    const f2 = feeOf(both.transfer)
    const minted = applyView(both.state, view(both.state, [f2, lockOf(both.transfer)]), NOW + 1000).state
    expect(toTransfer(minted, minted.transfers[both.transfer.id])).toMatchObject({ step: 3, feeTx: f2.tx })
    // the lock first: no fee yet, so no feeTx, until the fee arrives
    const w = waiting({ id: 'cdcdcdcdcdcdcdcd', n: 0xcd })
    expect(toTransfer(w.state, w.transfer).feeTx).toBeUndefined()
    const f3 = feeOf(w.transfer)
    const late = applyView(w.state, view(w.state, [f3]), NOW + 5000).state
    expect(toTransfer(late, late.transfers[w.transfer.id]).feeTx).toBe(f3.tx)
  })
  it('awaitingFee is there only while a lock waits for its fee', () => {
    const w = waiting()
    expect(toTransfer(w.state, w.transfer).awaitingFee).toBeDefined()
    const i = intent(base())
    expect(toTransfer(i.state, i.transfer).awaitingFee).toBeUndefined()
    const out = validateIntent(base(), { dir: 'out', sym: 'PETAL', amount: '1', from: EVM, to: ALICE })
    if (!out.ok) throw new Error(out.error)
    const o = createIntent(base(), out.intent, 'feefeefeefeefee2', NOW).transfer
    expect(toTransfer(base(), o).awaitingFee).toBeUndefined()
  })
})

describe('a lock the cap refused, whose refund the ledger then refused', () => {
  const refused = () => {
    const { state: s, transfer } = intent(base())
    s.tokens.PETAL.capUnits = '500'
    const fee = feeOf(transfer)
    const lock = lockOf(transfer, petal(), { from: BOB, tx: hashOf64(0xca9) })
    const first = applyView(s, view(s, [fee, lock]), NOW + 1000).state
    const refund = returnFor(first, lock.tx)!
    expect(first.transfers[transfer.id].refundActionId).toBe(refund.id)
    // the refund takes its sequence, then validates as a tec: nothing delivered, the fee taken
    const pending = applyView(first, view(first, [], accounts(10, 20)), NOW + 2000).state
    const failed = applyView(pending, view(pending, [{ ...outgoing(LOCK, pending.actions[refund.id].sequence!, 'tecNO_PERMISSION'), destination: BOB, amount: petal() }], accounts(11, 20)), NOW + 3000).state
    return { failed, transfer, lock, refund }
  }

  it('is owed back, not stranded: the transfer stays refused and no payment is on its way', () => {
    const { failed, transfer, refund } = refused()
    expect(failed.actions[refund.id].status).toBe('failed')
    const t = failed.transfers[transfer.id]
    expect(t.failed).toBe('cap')
    expect(t.refundActionId).toBeUndefined()
    expect(owedBack(t)).toBe(true)
  })

  it('is sent back when its sender asks with a return: payment, to the account that paid it', () => {
    const { failed, transfer, lock } = refused()
    const ask = returnPayment(lock.tx, '0.25', { from: BOB })
    const { state, applied } = applyView(failed, view(failed, [ask], accounts(11, 20)), NOW + 4000)
    expect(applied.map((a) => a.kind)).toContain('lock.returned')
    const t = state.transfers[transfer.id]
    expect(t.failed).toBe('returned')
    const back = state.actions[t.refundActionId!]
    expect(back.reason).toMatchObject({ kind: 'return', tx: lock.tx })
    expect((back.tx as any).Destination).toBe(BOB)
    expect(owedBack(t)).toBe(false)
  })

  it('is sent back by an operator\'s refund, once, and only to the account that paid it', async () => {
    const { applyAdmin } = await import('../src/admin')
    const { failed, transfer, lock } = refused()
    failed.config.admins = ['ed' + 'a'.repeat(64)]
    const r = applyAdmin(failed, 'ed' + 'a'.repeat(64), { cmd: 'refund', tx: lock.tx }, NOW + 4000)
    expect(r).toMatchObject({ ok: true })
    const t = failed.transfers[transfer.id]
    expect((failed.actions[t.refundActionId!].tx as any).Destination).toBe(BOB)
    // a second refund finds nothing owed
    expect(applyAdmin(failed, 'ed' + 'a'.repeat(64), { cmd: 'refund', tx: lock.tx }, NOW + 5000)).toMatchObject({ ok: false })
  })

  it('is not paid twice: while a refund is on its way, a return: payment is refused', () => {
    const { state: s, transfer } = intent(base())
    s.tokens.PETAL.capUnits = '500'
    const lock = lockOf(transfer, petal(), { from: BOB, tx: hashOf64(0xca8) })
    const first = applyView(s, view(s, [feeOf(transfer), lock]), NOW + 1000).state
    const ask = returnPayment(lock.tx, '0.25', { from: BOB })
    const after = applyView(first, view(first, [ask]), NOW + 2000).state
    expect(after.unmatched.map((u) => u.reason)).toContain('return:not-waiting')
  })
})
