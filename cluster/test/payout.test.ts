import { describe, expect, it } from 'vitest'
import { canon } from '../src/canon'
import * as dec from '../src/dec'
import { applyKeys, applyView } from '../src/machine'
import { configProblems } from '../src/state'
import { computeShares, schedulePayouts, settlePayout } from '../src/payout'
import type { ActionRec, OperatorKeys, State } from '../src/types'
import genesis from '../genesis/dev.json'
import { FUND, LOCK, NOW, baseState, pay, view, xrp } from './helpers'

const EVERY = genesis.config.params.payout.everyMs
const NODES = ['edAAA', 'edBBB', 'edCCC']
/** Payout addresses, deliberately not the nodes' own keys: cmpStr puts rOp… before rTreasury. */
const OPS = ['rOpA', 'rOpB', 'rOpC']
const TREASURY = 'rTreasury'

const base = baseState

const keysOf = (n: string, i: number): OperatorKeys => ({ node: n, xrplAddress: 'rNode' + n, xrplPublicKey: 'ED' + n, evmAddress: '0x' + n, payoutAddress: OPS[i] })

/** Operators known, the funding account seen with 1000 XRP, and `xrp` of fees taken. */
function ready(xrp = '0', byToken: Record<string, string> = {}): State {
  const s = base()
  NODES.forEach((n, i) => (s.operators[n] = keysOf(n, i)))
  s.accounts[FUND] = { sequence: 20, ledger: 100, balanceDrops: '1000000000' }
  s.fees.xrp = xrp
  s.fees.xrpByToken = byToken
  return s
}

const entryActions = (s: State) => s.fees.payouts.map((p) => s.actions[p.actionId])
const innerOf = (a: ActionRec) => ((a.tx as { RawTransactions?: { RawTransaction: Record<string, unknown> }[] }).RawTransactions ?? []).map((r) => r.RawTransaction)
const paidTo = (a: ActionRec) => innerOf(a).map((r) => String(r.Destination))
const sum = (xs: string[]) => xs.reduce((acc, x) => dec.add(acc, x), '0')

describe('share maths', () => {
  it('splits by params.split, floors every share to drops and gives the remainders to the treasury', () => {
    const s = ready('100', { PETAL: '100' })
    const plan = computeShares(s, NOW)
    expect(plan.blocked).toBeUndefined()
    expect(plan.distributable).toBe('100')
    // 70% over three operators: 23.333333 each, the 0.000001 that will not divide falls to the treasury.
    expect(plan.accruals).toEqual(OPS.map((to) => ({ to, xrp: '23.333333', role: 'operator' })))
    expect(plan.kept).toBe('30.000001')
    // Nothing is lost: every drop is either accrued or kept.
    expect(dec.add(sum(plan.accruals.map((a) => a.xrp)), plan.kept)).toBe('100')
    expect(plan.totalXrp).toBe('69.999999')
  })

  it("has no contributors' share: all of it is the operators' and the treasury's, however the fees were earned", () => {
    const s = ready('100', { PETAL: '60', XRP: '40' })
    const plan = computeShares(s, NOW)
    expect(plan.accruals.every((a) => a.role === 'operator')).toBe(true)
    expect(dec.add(sum(plan.accruals.map((a) => a.xrp)), plan.kept)).toBe('100')
    expect(plan.kept).toBe('30.000001')
  })

  it('reads the state without touching it', () => {
    const s = ready('100', { PETAL: '100' })
    const before = canon(s)
    computeShares(s, NOW)
    expect(canon(s)).toBe(before)
  })
})

describe('scheduling', () => {
  it('queues one Batch, records the period and clears what it paid', () => {
    const s = ready('100', { PETAL: '100' })
    const applied = schedulePayouts(s, NOW)
    expect(applied.map((a) => a.kind)).toEqual(['payout.queued'])
    const [action] = entryActions(s)
    expect(action.kind).toBe('xrpl.batch')
    expect(action.account).toBe('funding')
    expect(action.status).toBe('queued')
    expect(action.reason).toEqual({ kind: 'payout', at: NOW })
    const tx = action.tx as Record<string, unknown>
    expect(tx.TransactionType).toBe('Batch')
    // tfIndependent: one operator's payment bouncing must not take the others down with it.
    expect(tx.Flags).toBe(524288)
    expect(paidTo(action)).toEqual(OPS)
    expect(innerOf(action)[0]).toMatchObject({ TransactionType: 'Payment', Destination: OPS[0], Amount: '23333333', Account: FUND, Flags: 1073741824, Fee: '0', SigningPubKey: '' })
    expect(String((innerOf(action)[0] as { Memos: { Memo: { MemoType: string; MemoData: string } }[] }).Memos[0].Memo.MemoType)).toBe(Buffer.from('blume/payout').toString('hex').toUpperCase())
    const [entry] = s.fees.payouts
    expect(entry.totalXrp).toBe('69.999999')
    expect(entry.shares).toHaveLength(4)
    expect(entry.shares[3]).toEqual({ to: FUND, xrp: '30.000001', role: 'treasury', result: 'kept' })
    expect(s.fees.owed).toEqual({})
    expect(s.fees.lastPayoutAt).toBe(NOW)
  })

  it('keeps the treasury share in place, whether the account is unset or the funding account itself', () => {
    for (const treasuryAccount of [undefined, FUND]) {
      const s = ready('100', { XRP: '100' })
      s.config.params.payout!.treasuryAccount = treasuryAccount
      schedulePayouts(s, NOW)
      const [action] = entryActions(s)
      // A payment from the funding account to itself is temREDUNDANT and would fail the whole batch at preflight.
      expect(paidTo(action)).toEqual(OPS)
      expect(s.treasuryXrp).toBe('30.000001')
      // Kept XRP has left the distributable pool even though it never left the account.
      expect(s.fees.paidXrp).toBe('30.000001')
      expect(computeShares(s, NOW + EVERY).distributable).toBe('0')
    }
  })

  it('pays a treasury account that is not the funding account', () => {
    const s = ready('100', { XRP: '100' })
    s.config.params.payout!.treasuryAccount = TREASURY
    schedulePayouts(s, NOW)
    const [action] = entryActions(s)
    expect(paidTo(action)).toEqual([...OPS, TREASURY])
    expect(s.treasuryXrp).toBe('0')
    expect(s.fees.payouts[0].shares.find((sh) => sh.to === TREASURY)).toEqual({ to: TREASURY, xrp: '30.000001', role: 'treasury' })
  })

  it('accrues a share below the minimum and pays it once it is reached', () => {
    // 70% of 2.7 XRP over three operators is 0.63 each: under the 1 XRP reserve, so it waits rather than bouncing off an unfunded address.
    const s = ready('2.7', { XRP: '2.7' })
    expect(schedulePayouts(s, NOW)).toEqual([])
    expect(s.fees.owed).toEqual({ [OPS[0]]: '0.63', [OPS[1]]: '0.63', [OPS[2]]: '0.63' })
    expect(entryActions(s)).toEqual([])
    expect(s.fees.lastPayoutAt).toBe(NOW)
    // The next period brings the same again: 1.26 each, now over the minimum.
    s.fees.xrp = '5.4'
    expect(computeShares(s, NOW + EVERY).distributable).toBe('2.7')
    schedulePayouts(s, NOW + EVERY)
    const [batch] = entryActions(s)
    expect(batch.kind).toBe('xrpl.batch')
    expect(paidTo(batch)).toEqual(OPS)
    expect(innerOf(batch).map((r) => r.Amount)).toEqual(['1260000', '1260000', '1260000'])
    expect(s.fees.owed).toEqual({})
  })

  it('chunks nine recipients into a Batch of eight and a plain payment', () => {
    const s = ready('900', { XRP: '900' })
    s.operators = {}
    for (let i = 1; i <= 9; i++) s.operators[`ed${i}`] = { node: `ed${i}`, xrplAddress: `rN${i}`, xrplPublicKey: `ED${i}`, evmAddress: `0x${i}`, payoutAddress: `rC${i}` }
    const applied = schedulePayouts(s, NOW)
    expect(applied).toHaveLength(2)
    const [batch, single] = entryActions(s)
    expect(batch.kind).toBe('xrpl.batch')
    expect(paidTo(batch)).toEqual(['rC1', 'rC2', 'rC3', 'rC4', 'rC5', 'rC6', 'rC7', 'rC8'])
    expect(single.kind).toBe('xrpl.payment')
    expect((single.tx as { Destination: string }).Destination).toBe('rC9')
    expect(s.fees.payouts.map((p) => p.totalXrp)).toEqual(['560', '70'])
    expect(s.fees.payouts[0].shares).toHaveLength(9)
  })

  it('queues once when it runs twice in a row', () => {
    const s = ready('100', { XRP: '100' })
    expect(schedulePayouts(s, NOW)).toHaveLength(1)
    const after = canon(s)
    expect(schedulePayouts(s, NOW)).toEqual([])
    expect(schedulePayouts(s, NOW + EVERY - 1)).toEqual([])
    // The period has come round again, but the first batch is still in flight.
    expect(schedulePayouts(s, NOW + EVERY)).toEqual([])
    expect(canon(s)).toBe(after)
  })
})

describe('the balance floor', () => {
  const floored = (mutate: (s: State) => void) => {
    const s = ready('100', { XRP: '100' })
    mutate(s)
    const before = canon(s)
    expect(schedulePayouts(s, NOW)).toEqual([])
    expect(canon(s)).toBe(before)
    return computeShares(s, NOW).blocked
  }

  it('will not queue what the account cannot cover', () => {
    expect(floored((s) => (s.accounts[FUND].balanceDrops = '40000000'))).toMatch(/does not cover/)
  })

  it("will not spend the treasury's own XRP that sits in the same account", () => {
    expect(floored((s) => (s.treasuryXrp = '990'))).toMatch(/does not cover/)
    // The same account with nothing set aside pays.
    expect(schedulePayouts(ready('100', { XRP: '100' }), NOW)).toHaveLength(1)
  })

  it('will not queue before it has seen the account', () => {
    expect(floored((s) => delete s.accounts[FUND])).toBe('the funding balance is unknown')
  })
})

describe('the strict no-op', () => {
  const noop = (mutate: (s: State) => void) => {
    const s = ready('100', { XRP: '100' })
    mutate(s)
    const before = canon(s)
    expect(schedulePayouts(s, NOW)).toEqual([])
    expect(canon(s)).toBe(before)
    return computeShares(s, NOW).blocked
  }

  it('does nothing at all when payouts are off', () => {
    expect(noop((s) => delete s.config.params.payout)).toBe('payouts are off')
  })

  it('does nothing before the operator set is complete', () => {
    expect(noop((s) => delete s.operators.edCCC)).toBe('the operator set is not complete')
  })

  it('does nothing inside the period', () => {
    expect(noop((s) => (s.fees.lastPayoutAt = NOW - 1))).toMatch(/next period opens/)
  })

  it('does nothing while a payout is in flight', () => {
    expect(
      noop((s) => {
        s.actions.x = { id: 'x', kind: 'xrpl.batch', account: 'funding', tx: {}, status: 'pending', reason: { kind: 'payout', at: NOW - EVERY }, attempts: 0, createdAt: NOW - EVERY, updatedAt: NOW - EVERY }
      }),
    ).toBe('a payout is already in flight')
  })

  it('does nothing below the minimum', () => {
    expect(noop((s) => (s.fees.xrp = '0.4'))).toMatch(/below the 0.5 minimum/)
  })

  it('does nothing on a state that has never taken an XRP fee', () => {
    const s = ready()
    const before = canon(s)
    expect(schedulePayouts(s, NOW)).toEqual([])
    expect(canon(s)).toBe(before)
  })
})

/** Fills every inner slot of a queued action with one result, the way the ledger's view of the Batch would. */
function settleAll(s: State, action: ActionRec, result: string): void {
  const inner = innerOf(action)
  if (inner.length) action.inner = inner.map((_, i) => ({ sequence: 21 + i, hash: `H${i}`, result }))
  else {
    action.hash = 'H0'
    action.result = result
  }
  action.status = result === 'tesSUCCESS' ? 'validated' : 'failed'
  settlePayout(s, action, NOW + 1000)
}

describe('settlement', () => {
  const threeWay = () => {
    const s = ready('100', { XRP: '100' })
    schedulePayouts(s, NOW)
    return { s, action: entryActions(s)[0] }
  }

  it('records each inner on its own: paid, owed again after a tec, unapplied when the slot never filled', () => {
    const { s, action } = threeWay()
    expect(paidTo(action)).toEqual(OPS)
    action.inner = [
      { sequence: 21, hash: 'HA', result: 'tesSUCCESS' },
      { sequence: 22, hash: 'HB', result: 'tecUNFUNDED_PAYMENT' },
      { sequence: 23 },
    ]
    action.status = 'validated'
    const paidBefore = s.fees.paidXrp
    settlePayout(s, action, NOW + 1000)
    const shares = s.fees.payouts[0].shares
    expect(shares[0]).toMatchObject({ to: OPS[0], hash: 'HA', result: 'tesSUCCESS' })
    expect(shares[1]).toMatchObject({ to: OPS[1], hash: 'HB', result: 'tecUNFUNDED_PAYMENT' })
    expect(shares[2]).toMatchObject({ to: OPS[2], result: 'unapplied' })
    // What the ledger refused is owed again and goes out with the next period.
    expect(s.fees.owed).toEqual({ [OPS[1]]: '23.333333', [OPS[2]]: '23.333333' })
    // One share paid, plus the transaction fee the account paid whatever the inners did.
    expect(dec.sub(s.fees.paidXrp, paidBefore)).toBe('23.334333')
  })

  it('owes everyone again when the batch never applied', () => {
    const { s, action } = threeWay()
    action.status = 'failed'
    action.result = 'tecINSUFFICIENT_FUNDS'
    settlePayout(s, action, NOW + 1000)
    expect(s.fees.payouts[0].shares.filter((sh) => sh.result === 'unapplied')).toHaveLength(3)
    expect(Object.values(s.fees.owed)).toEqual(['23.333333', '23.333333', '23.333333'])
  })

  it('waits for the slots rather than trusting the outer Batch result', () => {
    const { s, action } = threeWay()
    // The outer Batch is tesSUCCESS even when every inner payment failed.
    action.status = 'validated'
    action.result = 'tesSUCCESS'
    const before = canon(s.fees)
    settlePayout(s, action, NOW + 1000)
    expect(canon(s.fees)).toBe(before)
  })

  it('changes nothing when the same action settles twice', () => {
    const { s, action } = threeWay()
    settleAll(s, action, 'tesSUCCESS')
    const after = canon(s)
    settlePayout(s, action, NOW + 2000)
    settlePayout(s, action, NOW + 3000)
    expect(canon(s)).toBe(after)
    expect(s.fees.paidXrp).toBe('100.001')
  })

  it("settles a lone recipient by the payment's own result", () => {
    // three operators that all want their share at one address: one recipient, so a plain payment and no Batch
    const s = ready('100', { XRP: '100' })
    for (const o of Object.values(s.operators)) o.payoutAddress = OPS[0]
    schedulePayouts(s, NOW)
    const [action] = entryActions(s)
    expect(action.kind).toBe('xrpl.payment')
    settleAll(s, action, 'tesSUCCESS')
    expect(s.fees.payouts[0].shares[0]).toMatchObject({ to: OPS[0], xrp: '69.999999', hash: 'H0', result: 'tesSUCCESS' })
    expect(s.fees.paidXrp).toBe('100.001')
  })

  it('finds its payout again after the action was re-queued under a new id', () => {
    const { s, action } = threeWay()
    // expireActions re-queues a transaction the ledger never showed; the payout is found again by its shares, not by the action id.
    const retry: ActionRec = { ...structuredClone(action), id: 'retried', attempts: 1 }
    s.actions[retry.id] = retry
    settleAll(s, retry, 'tesSUCCESS')
    expect(s.fees.payouts[0].actionId).toBe('retried')
    expect(s.fees.payouts[0].shares.every((sh) => sh.result === 'tesSUCCESS' || sh.result === 'kept')).toBe(true)
  })

  it('never shares the same XRP twice over a full cycle', () => {
    const s = ready('100', { XRP: '100' })
    schedulePayouts(s, NOW)
    settleAll(s, entryActions(s)[0], 'tesSUCCESS')
    // Every one of the 100 XRP is allocated: the operators' shares, the treasury share kept in place, and the transaction fee the account paid to send them.
    expect(s.fees.paidXrp).toBe('100.001')
    expect(computeShares(s, NOW + EVERY).distributable).toBe('0')
  })
})

describe('operator payout addresses', () => {
  it('applyKeys carries payoutAddress into the operator set', () => {
    const set = NODES.map(keysOf)
    const r = applyKeys(base(), set, NODES)
    expect(r.applied).toHaveLength(1)
    expect(Object.values(r.state.operators).map((o) => o.payoutAddress)).toEqual(OPS)
    // Idempotent, and a set with no payout addresses leaves the field off rather than inventing one.
    expect(applyKeys(r.state, set, NODES).applied).toHaveLength(0)
    const plain = applyKeys(base(), set.map(({ payoutAddress, ...rest }) => rest), NODES)
    expect(plain.state.operators.edAAA.payoutAddress).toBeUndefined()
  })

  it('pays an operator at its own key when it published no payout address', () => {
    const s = ready('100', { XRP: '100' })
    delete s.operators.edBBB.payoutAddress
    expect(computeShares(s, NOW).accruals.map((a) => a.to)).toEqual([OPS[0], 'rNodeedBBB', OPS[2]])
  })
})

describe('the lock account top-up', () => {
  /** The dev genesis lists XRP (native, so no trust line) and PETAL: the lock account owns its signer list and one line, a reserve of 1.4 XRP. */
  const lockHolding = (xrp: string): State => {
    const s = ready('100', { XRP: '100' })
    s.accounts[LOCK] = { sequence: 10, ledger: 100, balanceDrops: dec.toDrops(xrp) }
    return s
  }

  it('comes first: the lock account is topped up to its floor above the reserve, and the rest is split', () => {
    // 2 XRP held, 1.4 of it reserve: 0.6 free against a floor of 10 is 9.4 short
    const s = lockHolding('2')
    const plan = computeShares(s, NOW)
    expect(plan.lockTopUp).toBe('9.4')
    expect(plan.pay[0]).toEqual({ to: LOCK, xrp: '9.4', role: 'lock' })
    // the other 90.6 is what the 70/30 split sees: 63.42 over three operators, 27.18 to the treasury
    expect(plan.accruals).toEqual(OPS.map((to) => ({ to, xrp: '21.14', role: 'operator' })))
    expect(plan.kept).toBe('27.18')
    expect(plan.totalXrp).toBe('72.82')
    expect(dec.add(dec.add(sum(plan.accruals.map((a) => a.xrp)), plan.kept), plan.lockTopUp)).toBe('100')
  })

  it('goes out as the first inner payment of the batch, under its own memo', () => {
    const s = lockHolding('2')
    schedulePayouts(s, NOW)
    const [action] = entryActions(s)
    expect(paidTo(action)).toEqual([LOCK, ...OPS])
    expect(innerOf(action)[0]).toMatchObject({ Destination: LOCK, Amount: '9400000' })
    const memoType = (r: Record<string, unknown>) => Buffer.from((r as { Memos: { Memo: { MemoType: string } }[] }).Memos[0].Memo.MemoType, 'hex').toString()
    expect(memoType(innerOf(action)[0])).toBe('blume/topup')
    expect(memoType(innerOf(action)[1])).toBe('blume/payout')
    expect(s.fees.payouts[0].shares[0]).toEqual({ to: LOCK, xrp: '9.4', role: 'lock' })
    // it is not an accrual and nothing is owed to the lock account
    expect(s.fees.owed).toEqual({})
  })

  it('arrives at the lock account as the cluster\'s own payment: not a lock to match, and not an unmatched one to record every period', () => {
    // the feed reports the top-up as a payment to the lock account from the funding account, with the period as its memo
    for (const xrpListed of [true, false]) {
      const s = lockHolding('2')
      if (!xrpListed) delete s.tokens.XRP
      const topUp = pay(LOCK, xrp('9.4'), String(NOW), { from: FUND })
      const { state, applied } = applyView(s, view(s, [topUp]), NOW)
      expect(applied.map((a) => a.kind)).toEqual(['topup.received'])
      expect(state.unmatched).toEqual([])
      expect(Object.keys(state.transfers)).toEqual([])
      expect(state.tokens.PETAL.lockedUnits).toBe('0')
    }
  })

  it('tops up only what is missing, and nothing when the account already holds its floor', () => {
    expect(computeShares(lockHolding('11.4'), NOW).lockTopUp).toBe('0')
    expect(computeShares(lockHolding('50'), NOW).lockTopUp).toBe('0')
    expect(computeShares(lockHolding('10'), NOW).lockTopUp).toBe('1.4')
    // nothing to top up: the whole 100 is split, as before the floor existed
    expect(computeShares(lockHolding('50'), NOW).pay.map((p) => p.to)).toEqual(OPS)
  })

  it('cannot give more than the fees of the period, and then pays only the lock account', () => {
    const s = ready('5', { XRP: '5' })
    s.accounts[LOCK] = { sequence: 10, ledger: 100, balanceDrops: '1400000' }
    const plan = computeShares(s, NOW)
    expect(plan.lockTopUp).toBe('5')
    expect(plan.accruals).toEqual([])
    expect(plan.kept).toBe('0')
    schedulePayouts(s, NOW)
    const [action] = entryActions(s)
    // one recipient: a plain payment, not a Batch
    expect(action.kind).toBe('xrpl.payment')
    expect(action.tx).toMatchObject({ Destination: LOCK, Amount: '5000000' })
  })

  it('does not count the XRP held for users as the lock account\'s own', () => {
    const s = lockHolding('55')
    // 50.5 of the 55 backs the ERC-20 and the surplus of the XRP token: 55 - 1.4 - 50.5 = 3.1 is the account's own
    s.tokens.XRP.lockedUnits = '50'
    s.tokens.XRP.dustUnits = '0.5'
    expect(computeShares(s, NOW).lockTopUp).toBe('6.9')
  })

  it('reserves for every trust line it holds or is about to open, but not for one that failed', () => {
    const s = lockHolding('11.4')
    expect(computeShares(s, NOW).lockTopUp).toBe('0')
    // two more lines: 0.4 XRP more reserve
    for (const sym of ['AAA', 'BBB']) s.tokens[sym] = { sym, name: sym, issuer: 'rIssuer' + sym, currency: sym, status: 'listed', lockedUnits: '0', dustUnits: '0', trustLine: 'pending' }
    expect(computeShares(s, NOW).lockTopUp).toBe('0.4')
    s.tokens.BBB.trustLine = 'failed'
    expect(computeShares(s, NOW).lockTopUp).toBe('0.2')
  })

  it('is off without a floor, and waits until the lock account has been seen', () => {
    const noFloor = lockHolding('2')
    delete noFloor.config.params.payout!.lockFloorXrp
    expect(computeShares(noFloor, NOW).lockTopUp).toBe('0')
    expect(computeShares(ready('100', { XRP: '100' }), NOW).lockTopUp).toBe('0')
  })

  it('a refused top-up is owed to nobody: it falls back into the pool and the next period works the need out again', () => {
    const s = lockHolding('2')
    schedulePayouts(s, NOW)
    const [action] = entryActions(s)
    action.inner = innerOf(action).map((_, i) => ({ sequence: 21 + i, hash: `H${i}`, result: i === 0 ? 'tecNO_DST' : 'tesSUCCESS' }))
    action.status = 'validated'
    settlePayout(s, action, NOW + 1000)
    expect(s.fees.payouts[0].shares[0]).toMatchObject({ to: LOCK, role: 'lock', result: 'tecNO_DST' })
    expect(s.fees.owed[LOCK]).toBeUndefined()
    // the 9.4 was not paid and not owed, so it is distributable again, less the 0.001 the batch cost whatever its payments did
    expect(computeShares(s, NOW + EVERY).distributable).toBe('9.399')
  })

  it('a payout never spends the XRP the funding account still has to send back', () => {
    const s = ready('100', { XRP: '100' })
    // 1000 XRP held; a return of 930 that has not gone yet leaves 70 minus the reserve, and the treasury's share has to stay too
    s.actions.back = { id: 'back', kind: 'xrpl.payment', account: 'funding', tx: { TransactionType: 'Payment', Destination: 'rPayer', Amount: dec.toDrops('930'), Fee: '1000' }, status: 'queued', reason: { kind: 'return', tx: 'X', to: 'rPayer' }, attempts: 0, createdAt: NOW, updatedAt: NOW }
    expect(computeShares(s, NOW).blocked).toMatch(/does not cover/)
    s.actions.back.status = 'validated'
    s.accounts[FUND].balanceDrops = dec.toDrops(dec.sub('1000', '930.001'))
    // now 69.999 is held, in its own right, and the payout needs 69.999999 + its fee: still blocked, by the balance itself
    expect(computeShares(s, NOW).blocked).toMatch(/does not cover/)
  })
})

describe('the read-only preview', () => {
  it('shows the shares instead of a countdown from a timestamp it does not have', () => {
    const s = ready('100', { XRP: '100' })
    s.fees.lastPayoutAt = NOW
    // ctx.timestamp is 0 in a read-only execution; a naive countdown would report a number the size of the epoch.
    const plan = computeShares(s, 0)
    expect(plan.blocked).toBeUndefined()
    expect(plan.accruals.length).toBeGreaterThan(0)
    // Inside a round the period is still enforced.
    expect(computeShares(s, NOW + 1000).blocked).toBe('the next period opens in 599s')
  })
})

describe('where an operator that published no payout address is paid', () => {
  /** Operators that published nothing: each registered its own key as its payout address, as a node with no payout file does. */
  function bare(xrp = '100'): State {
    const s = ready(xrp)
    NODES.forEach((n) => (s.operators[n] = { node: n, xrplAddress: 'rNode' + n, xrplPublicKey: 'ED' + n, evmAddress: '0x' + n, payoutAddress: 'rNode' + n }))
    return s
  }

  it('is its own key by default', () => {
    const plan = computeShares(bare(), NOW)
    expect(plan.accruals.filter((a) => a.role === 'operator').map((a) => a.to)).toEqual(NODES.map((n) => 'rNode' + n))
  })
  it('is the cluster\'s default operator address when one is set, and an address an operator published still wins', () => {
    const s = bare()
    s.config.params.payout!.operatorPayout = 'rOwner'
    s.operators.edAAA.payoutAddress = 'rMine'
    const plan = computeShares(s, NOW)
    expect(plan.accruals.filter((a) => a.role === 'operator').map((a) => a.to).sort()).toEqual(['rMine', 'rOwner', 'rOwner'])
  })
  it('keeps the share in the cluster\'s account when the default is the funding account: owed to it, never paid, never spent on others', () => {
    const s = bare('100')
    s.config.params.payout!.operatorPayout = FUND
    schedulePayouts(s, NOW)
    // the operators' 70 stays owed to the funding account; the treasury's 30 stays in the treasury bucket
    expect(s.fees.owed[FUND]).toBe('69.999999')
    expect(entryActions(s)).toEqual([]) // nobody to pay: the only recipients are the account itself
    expect(dec.add(s.treasuryXrp, s.fees.owed[FUND])).toBe('100')
    // and it is not distributable again next period
    const next = computeShares({ ...s, fees: { ...s.fees, lastPayoutAt: 0 } } as State, NOW + EVERY)
    expect(next.distributable).toBe('0')
  })
  it('still pays the others when only some operators are held', () => {
    const s = bare('100')
    s.config.params.payout!.operatorPayout = FUND
    s.operators.edBBB.payoutAddress = 'rMine'
    s.config.params.payout!.treasuryAccount = TREASURY
    schedulePayouts(s, NOW)
    const paid = entryActions(s).flatMap(paidTo).sort()
    expect(paid).toEqual(['rMine', TREASURY].sort())
    expect(s.fees.owed[FUND]).toBe('46.666666') // two operators held
  })
  it('does not spend the held XRP on another recipient\'s payout', () => {
    const s = bare('100')
    s.config.params.payout!.operatorPayout = FUND
    s.operators.edBBB.payoutAddress = 'rMine'
    s.config.params.payout!.treasuryAccount = TREASURY
    // the account holds just the reserve and what is held: nothing is free for the 23 + 30 that would be paid
    s.accounts[FUND] = { sequence: 20, ledger: 100, balanceDrops: '60000000' }
    schedulePayouts(s, NOW)
    expect(entryActions(s)).toEqual([])
    expect(computeShares(s, NOW).blocked).toMatch(/free does not cover/)
  })
  it('refuses a default operator address that is not an address, or is the lock account', () => {
    const s = bare()
    s.config.params.payout!.operatorPayout = 'nope'
    expect(configProblems(s.config).join()).toMatch(/operatorPayout must be an XRPL address/)
    s.config.params.payout!.operatorPayout = LOCK
    expect(configProblems(s.config).join()).toMatch(/operatorPayout must be an XRPL address other than the lock account/)
    s.config.params.payout!.operatorPayout = FUND
    expect(configProblems(s.config)).toEqual([])
  })
})
