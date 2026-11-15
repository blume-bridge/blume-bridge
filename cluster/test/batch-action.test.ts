import { describe, expect, it } from 'vitest'
import { applyView, batchTx, queueAction, tick } from '../src/machine'
import type { ActionRec, State, XrplOutgoingEvent, XrplPaymentEvent, XrplView } from '../src/types'
import genesis from '../genesis/dev.json'
import { baseState } from './helpers'

const ALICE = 'rJfqVsXN3i6AD9ErSdNo98cyoKw6Euxj8K'
const BOB = 'rpXzhnkZN2JArdmWAk3tmrtJwsErv963Na'
const NOW = 1788912000000

const base = baseState
const LOCK = genesis.config.xrpl.lockAccount
const FUND = genesis.config.xrpl.fundingAccount
const accounts = (lockSeq = 10, fundSeq = 20) => ({ [LOCK]: { sequence: lockSeq, balanceDrops: '100000000' }, [FUND]: { sequence: fundSeq, balanceDrops: '125000000' } })
let seq = 0
const view = (s: State, events: (XrplPaymentEvent | XrplOutgoingEvent)[], acc = accounts()): XrplView => ({ src: 'xrpl', from: s.cursor.xrpl.ledger, to: s.cursor.xrpl.ledger + 5, events, accounts: acc })
function outgoing(account: string, sequence: number, result = 'tesSUCCESS', type = 'Payment'): XrplOutgoingEvent {
  seq++
  return { kind: 'outgoing', tx: `OUT${String(seq).padStart(4, '0')}`, ledger: 103, account, type, result, sequence }
}

const ALL_OR_NOTHING = 65536
const INDEPENDENT = 524288
const INNER_FLAG = 1073741824
const payment = (to: string, drops: string) => ({ TransactionType: 'Payment', Destination: to, Amount: drops })
const raw = (a: ActionRec) => (a.tx as any).RawTransactions as { RawTransaction: Record<string, unknown> }[]

/** A batch from the funding account, queued and promoted: outer at 20, inners at 21 and 22. */
function pendingBatch(flags = INDEPENDENT, reason: ActionRec['reason'] = { kind: 'payout', at: NOW }): { s: State; id: string } {
  const s0 = base()
  const { id } = queueAction(s0, 'xrpl.batch', 'funding', batchTx(FUND, [payment(ALICE, '1000000'), payment(BOB, '2000000')], flags), reason, NOW)
  const s = applyView(s0, view(s0, []), NOW).state
  expect(s.actions[id].status).toBe('pending')
  return { s, id }
}
const results = (a: ActionRec) => a.inner!.map((x) => x.result)

describe('batchTx', () => {
  it('stamps every inner as the ledger wants it and leaves the outer to queueAction', () => {
    const tx = batchTx(FUND, [payment(ALICE, '1'), { ...payment(BOB, '2'), Flags: 2147483648 }], INDEPENDENT) as any
    expect(tx).toMatchObject({ TransactionType: 'Batch', Flags: INDEPENDENT })
    expect(tx.Account).toBeUndefined()
    expect(tx.RawTransactions).toHaveLength(2)
    for (const { RawTransaction } of tx.RawTransactions) expect(RawTransaction).toMatchObject({ TransactionType: 'Payment', Account: FUND, Fee: '0', SigningPubKey: '' })
    expect(tx.RawTransactions[0].RawTransaction.Flags).toBe(INNER_FLAG)
    expect(tx.RawTransactions[1].RawTransaction.Flags).toBe((2147483648 | INNER_FLAG) >>> 0)
  })
  it('refuses fewer than 2 or more than 8 inner, and anything but one mode flag', () => {
    const p = () => payment(ALICE, '1')
    expect(() => batchTx(FUND, [p()], INDEPENDENT)).toThrow(/2 to 8/)
    expect(() => batchTx(FUND, Array.from({ length: 9 }, p), INDEPENDENT)).toThrow(/2 to 8/)
    expect(() => batchTx(FUND, Array.from({ length: 8 }, p), ALL_OR_NOTHING)).not.toThrow()
    for (const bad of [0, 1, INNER_FLAG, ALL_OR_NOTHING | INDEPENDENT, 131072 + 1]) expect(() => batchTx(FUND, [p(), p()], bad)).toThrow(/mode flag/)
    for (const good of [65536, 131072, 262144, 524288]) expect(() => batchTx(FUND, [p(), p()], good)).not.toThrow()
  })
})

describe('a queued batch', () => {
  it('has a slot per inner, and promotion gives it S, S+1, S+2 with the expiry on the outer only', () => {
    const s0 = base()
    const a = queueAction(s0, 'xrpl.batch', 'funding', batchTx(FUND, [payment(ALICE, '1000000'), payment(BOB, '2000000')], INDEPENDENT), { kind: 'payout', at: NOW }, NOW)
    expect(a.tx).toMatchObject({ Account: FUND, Fee: '1000' })
    expect(a.inner).toEqual([{ sequence: 0 }, { sequence: 0 }])
    const { state: s, applied } = applyView(s0, view(s0, []), NOW)
    const p = s.actions[a.id]
    expect(p.status).toBe('pending')
    expect(p.sequence).toBe(20)
    expect(p.lastLedger).toBe(105 + genesis.config.params.actionTtlLedgers)
    expect(p.tx).toMatchObject({ Sequence: 20, LastLedgerSequence: p.lastLedger })
    expect(raw(p).map((r) => r.RawTransaction.Sequence)).toEqual([21, 22])
    expect(raw(p).every((r) => !('LastLedgerSequence' in r.RawTransaction))).toBe(true)
    expect(p.inner).toEqual([{ sequence: 21 }, { sequence: 22 }])
    expect(s.accounts[FUND].inflight).toBe(a.id)
    expect(s.accounts[FUND].balanceDrops).toBe('125000000')
    expect(applied.map((x) => x.kind)).toEqual(['action.pending'])
    expect(applied[0].detail).toContain('seq 20+2')
  })
})

describe('a validated batch', () => {
  it('lands inner events in their slots even when hash order puts them before the outer, then settles', () => {
    const { s, id } = pendingBatch()
    // OUT numbers rise, so the inners sort before the outer within the ledger
    const in21 = outgoing(FUND, 21)
    const in22 = outgoing(FUND, 22)
    const outer = { ...outgoing(FUND, 20, 'tesSUCCESS', 'Batch'), inner: 2 }
    const r = applyView(s, view(s, [outer, in22, in21], accounts(10, 23)), NOW + 5)
    expect(r.applied.map((x) => x.kind)).toEqual(['batch.inner', 'batch.inner', 'action.validated', 'batch.validated'])
    const a = r.state.actions[id]
    expect(a.status).toBe('validated')
    expect(a.hash).toBe(outer.tx)
    expect(a.result).toBe('tesSUCCESS')
    expect(a.inner).toEqual([{ sequence: 21, hash: in21.tx, result: 'tesSUCCESS' }, { sequence: 22, hash: in22.tx, result: 'tesSUCCESS' }])
    expect(a.updatedAt).toBe(NOW + 5)
    expect(r.state.accounts[FUND].inflight).toBeUndefined()
    expect(r.state.accounts[FUND].sequence).toBe(23)
    // nothing settles twice: the next view leaves it alone
    const again = applyView(r.state, view(r.state, [], accounts(10, 23)), NOW + 6)
    expect(again.applied).toHaveLength(0)
    expect(again.state.actions[id]).toEqual(a)
  })
  it('an AllOrNothing outer with no inner events by the end of its view settles as failed with every inner unapplied', () => {
    const { s, id } = pendingBatch(ALL_OR_NOTHING, { kind: 'trustline', sym: 'PETAL' })
    const outer = outgoing(FUND, 20, 'tesSUCCESS', 'Batch')
    const r = applyView(s, view(s, [outer], accounts(10, 23)), NOW)
    expect(r.applied.map((x) => x.kind)).toEqual(['action.validated', 'batch.failed'])
    const a = r.state.actions[id]
    expect(a.status).toBe('failed')
    expect(a.hash).toBe(outer.tx)
    expect(a.inner).toEqual([{ sequence: 21, result: 'unapplied' }, { sequence: 22, result: 'unapplied' }])
    expect(r.state.accounts[FUND].inflight).toBeUndefined()
    // settle() saw ok=false: the trust line reason records the failure
    expect(r.state.tokens.PETAL.trustLine).toBe('failed')
  })
  it('an Independent batch with one tesSUCCESS and one tecNO_DST inner settles per inner and is not ok', () => {
    const { s, id } = pendingBatch(INDEPENDENT, { kind: 'trustline', sym: 'PETAL' })
    const outer = outgoing(FUND, 20, 'tesSUCCESS', 'Batch')
    const in21 = outgoing(FUND, 21)
    const in22 = outgoing(FUND, 22, 'tecNO_DST')
    const r = applyView(s, view(s, [outer, in21, in22], accounts(10, 23)), NOW)
    expect(r.applied.map((x) => x.kind)).toEqual(['action.validated', 'batch.inner', 'batch.inner', 'batch.failed'])
    const a = r.state.actions[id]
    expect(a.status).toBe('failed')
    expect(a.inner).toEqual([{ sequence: 21, hash: in21.tx, result: 'tesSUCCESS' }, { sequence: 22, hash: in22.tx, result: 'tecNO_DST' }])
    expect(r.state.accounts[FUND].inflight).toBeUndefined()
    expect(r.state.tokens.PETAL.trustLine).toBe('failed')
    // and one where both inners went through is ok
    const good = pendingBatch(INDEPENDENT, { kind: 'trustline', sym: 'PETAL' })
    const g = applyView(good.s, view(good.s, [outgoing(FUND, 20, 'tesSUCCESS', 'Batch'), outgoing(FUND, 21), outgoing(FUND, 22)], accounts(10, 23)), NOW).state
    expect(g.actions[good.id].status).toBe('validated')
    expect(results(g.actions[good.id])).toEqual(['tesSUCCESS', 'tesSUCCESS'])
    expect(g.tokens.PETAL.trustLine).toBe('set')
  })
  it('a refused outer applied nothing and fails like any action, releasing the account', () => {
    const { s, id } = pendingBatch(INDEPENDENT, { kind: 'trustline', sym: 'PETAL' })
    const r = applyView(s, view(s, [outgoing(FUND, 20, 'tecINSUFFICIENT_RESERVE', 'Batch')], accounts(10, 21)), NOW)
    expect(r.applied.map((x) => x.kind)).toEqual(['action.failed'])
    expect(r.state.actions[id].status).toBe('failed')
    expect(results(r.state.actions[id])).toEqual([undefined, undefined])
    expect(r.state.accounts[FUND].inflight).toBeUndefined()
    expect(r.state.tokens.PETAL.trustLine).toBe('failed')
  })
})

describe('a batch that goes back in the queue', () => {
  /** A plain payment queued behind the batch with an earlier createdAt, so the re-queued batch stays queued and its stripped shape can be seen. */
  function withOlderPayment(s: State): State {
    const s1 = structuredClone(s)
    queueAction(s1, 'xrpl.payment', 'funding', payment(ALICE, '5'), { kind: 'return', tx: 'X', to: ALICE }, NOW - 1)
    return s1
  }
  const stripped = (a: ActionRec) => {
    expect(a.status).toBe('queued')
    expect('Sequence' in a.tx).toBe(false)
    expect('LastLedgerSequence' in a.tx).toBe(false)
    expect(raw(a).every((r) => !('Sequence' in r.RawTransaction) && !('LastLedgerSequence' in r.RawTransaction))).toBe(true)
    expect(a.inner).toEqual([{ sequence: 0 }, { sequence: 0 }])
    expect(a.tx).toMatchObject({ TransactionType: 'Batch', Account: FUND, Fee: '1000', Flags: INDEPENDENT })
  }
  it('on expiry: the retry has no sequences and fresh slots', () => {
    const { s, id } = pendingBatch()
    const s1 = withOlderPayment(s)
    const far = { ...s1, cursor: { xrpl: { ledger: s1.actions[id].lastLedger! + 1, seen: [] } } }
    const r = applyView(far, view(far, [], accounts(10, 20)), NOW)
    expect(r.applied.map((x) => x.kind)).toEqual(['action.expired', 'action.pending'])
    expect(r.state.actions[id].status).toBe('expired')
    const retry = Object.values(r.state.actions).find((a) => a.kind === 'xrpl.batch' && a.id !== id)!
    expect(retry.attempts).toBe(1)
    stripped(retry)
    // the older payment took the account; the retry is promoted once it settles
    const older = Object.values(r.state.actions).find((a) => a.kind === 'xrpl.payment')!
    expect(older.status).toBe('pending')
    expect(older.sequence).toBe(20)
    const r2 = applyView(r.state, view(r.state, [{ ...outgoing(FUND, 20), destination: ALICE, amount: { currency: 'XRP', value: '0.000005' } }], accounts(10, 21)), NOW).state
    const promoted = r2.actions[retry.id]
    expect(promoted.status).toBe('pending')
    expect(promoted.sequence).toBe(21)
    expect(raw(promoted).map((x) => x.RawTransaction.Sequence)).toEqual([22, 23])
    expect(promoted.inner).toEqual([{ sequence: 22 }, { sequence: 23 }])
  })
  it('on a collision: something else took S, the retry has no sequences and fresh slots', () => {
    const { s, id } = pendingBatch()
    const s1 = withOlderPayment(s)
    const stranger = { ...outgoing(FUND, 20), destination: BOB, amount: { currency: 'XRP', value: '5' } }
    const r = applyView(s1, view(s1, [stranger], accounts(10, 21)), NOW)
    expect(r.applied.map((x) => x.kind)).toEqual(['action.collided', 'action.pending'])
    expect(r.state.actions[id].status).toBe('expired')
    expect(r.state.actions[id].result).toContain('sequence taken')
    const retry = Object.values(r.state.actions).find((a) => a.kind === 'xrpl.batch' && a.id !== id)!
    expect(retry.attempts).toBe(0)
    stripped(retry)
  })
  it('a Batch at S with a different inner count is a collision too; the right count matches', () => {
    const { s, id } = pendingBatch()
    const wrong = applyView(s, view(s, [{ ...outgoing(FUND, 20, 'tesSUCCESS', 'Batch'), inner: 3 }], accounts(10, 24)), NOW)
    expect(wrong.applied.map((x) => x.kind)).toContain('action.collided')
    expect(wrong.state.actions[id].status).toBe('expired')
    const right = applyView(s, view(s, [{ ...outgoing(FUND, 20, 'tesSUCCESS', 'Batch'), inner: 2 }, outgoing(FUND, 21), outgoing(FUND, 22)], accounts(10, 23)), NOW)
    expect(right.state.actions[id].status).toBe('validated')
  })
  it('an expired batch settles as failed on the third try, with the account free', () => {
    let { s, id } = pendingBatch(INDEPENDENT, { kind: 'trustline', sym: 'PETAL' })
    for (let i = 0; i < 3; i++) {
      const open = Object.values(s.actions).find((a) => a.status === 'pending')!
      const far = { ...s, cursor: { xrpl: { ledger: open.lastLedger! + 1, seen: [] } } }
      s = applyView(far, view(far, [], accounts(10, 20)), NOW + i).state
      id = open.id
    }
    expect(Object.values(s.actions).map((a) => a.status).sort()).toEqual(['expired', 'expired', 'expired'])
    expect(s.tokens.PETAL.trustLine).toBe('failed')
    expect(s.accounts[FUND].inflight).toBeUndefined()
  })
})

describe('plain actions are unaffected', () => {
  function pendingPayment(): { s: State; id: string } {
    const s0 = base()
    const { id } = queueAction(s0, 'xrpl.payment', 'funding', payment(ALICE, '1000000'), { kind: 'return', tx: 'X', to: ALICE }, NOW)
    const s = applyView(s0, view(s0, []), NOW).state
    return { s, id }
  }
  it('validates, fails and collides as before, with no inner slots', () => {
    const { s, id } = pendingPayment()
    expect(s.actions[id].inner).toBeUndefined()
    expect(s.actions[id].sequence).toBe(20)
    const ok = applyView(s, view(s, [{ ...outgoing(FUND, 20), destination: ALICE, amount: { currency: 'XRP', value: '1' } }], accounts(10, 21)), NOW)
    expect(ok.applied.map((x) => x.kind)).toEqual(['action.validated'])
    expect(ok.state.actions[id].status).toBe('validated')
    expect(ok.state.accounts[FUND].inflight).toBeUndefined()
    const bad = applyView(s, view(s, [outgoing(FUND, 20, 'tecNO_DST')], accounts(10, 21)), NOW)
    expect(bad.applied.map((x) => x.kind)).toEqual(['action.failed'])
    expect(bad.state.actions[id].status).toBe('failed')
    expect(bad.state.accounts[FUND].inflight).toBeUndefined()
    const taken = applyView(s, view(s, [outgoing(FUND, 20, 'tesSUCCESS', 'AccountSet')], accounts(10, 21)), NOW)
    expect(taken.applied.map((x) => x.kind)).toEqual(['action.collided', 'action.pending'])
    expect(taken.state.actions[id].status).toBe('expired')
    const retry = Object.values(taken.state.actions).find((a) => a.status === 'pending')!
    expect(retry.sequence).toBe(21)
    expect(retry.inner).toBeUndefined()
    expect('Sequence' in retry.tx && 'LastLedgerSequence' in retry.tx).toBe(true)
  })
  it('a stray transaction from our account at an unheld sequence is unmatched, never an inner', () => {
    const { s } = pendingBatch()
    const r = applyView(s, view(s, [outgoing(FUND, 40)], accounts(10, 20)), NOW)
    expect(r.applied.map((x) => x.kind)).toEqual(['outgoing.unmatched'])
    expect(results(Object.values(r.state.actions)[0])).toEqual([undefined, undefined])
  })
  it('tick runs the payout scheduler hook without queueing anything yet', () => {
    const s = base()
    const r = tick(s, NOW)
    expect(r.applied).toHaveLength(0)
    expect(Object.keys(r.state.actions)).toHaveLength(0)
  })
})
