import { describe, expect, it } from 'vitest'
import * as dec from '../src/dec'
import { applyView, tick } from '../src/machine'
import { settlePayout } from '../src/payout'
import type { IssuerFlags } from '../src/types'
import { ALICE, BOB, FUND, LOCK, NOW, accounts, baseState, executeFundingActions, feeOf, hashOf64, intent, leaves, lockOf, outgoing, pay, petal, view, xrp } from './helpers'

/**
 * The funding account's XRP accounting closes. Everything that reaches it is
 * either booked as fee revenue or sent back, and everything that leaves it is
 * a return, a payout share, or the network fee of one of those. So after any
 * mix of them, what it holds has moved by exactly what the books say:
 *
 *   balance now - balance then = fees.xrp - fees.paidXrp + treasuryXrp
 *
 * (paidXrp includes the batches' own fees and the treasury share kept in place,
 * which is what treasuryXrp holds.) The scenario below is built from the
 * ledger's side: the balance is simulated from the events that reach the
 * account and the actions that leave it, not read back from the state.
 */

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const MOO = '4D4F4F0000000000000000000000000000000000'
const TREASURY = 'rTreasury'
const signs: IssuerFlags = { noFreeze: true, globalFreeze: false, requireAuth: false, clawback: false, defaultRipple: true, disableMaster: false, blackholed: false, transferRate: 1_000_000_000 }

describe('the funding account closes its books', () => {
  it('after a fee, a listing, a refusal, a return fee, a retired round and a payout with a lock top-up', () => {
    const B0 = '100'
    let balance = B0
    let s = baseState()
    s.config.params.payout!.treasuryAccount = TREASURY
    for (const [i, n] of ['edAAA', 'edBBB', 'edCCC'].entries()) s.operators[n] = { node: n, xrplAddress: 'rNode' + n, xrplPublicKey: 'ED' + n, evmAddress: '0x' + n, payoutAddress: ['rOpA', 'rOpB', 'rOpC'][i] }
    const lockBalance = '2'
    const snapshot = () => accounts(10, 20, dec.toDrops(lockBalance), dec.toDrops(balance))
    const inflow = (events: { to: string; amount: { currency: string; value: string } }[]) => events.filter((e) => e.to === FUND && e.amount.currency === 'XRP').reduce((sum, e) => dec.add(sum, e.amount.value), '0')

    // --- view 1: a bridge-in with its fee; an underpaid fee; a listing; a refusal; a lock still waiting for its fee; a fee too small to send back
    const i1 = intent(s, { id: 'a1a1a1a1a1a1a1a1' })
    const i2 = intent(i1.state, { id: 'a2a2a2a2a2a2a2a2' })
    const i3 = intent(i2.state, { id: 'a3a3a3a3a3a3a3a3' })
    s = i3.state
    const lock3 = lockOf(i3.transfer, petal(), { tx: hashOf64(0x33) })
    const first = [
      feeOf(i1.transfer, '1'),
      lockOf(i1.transfer),
      feeOf(i2.transfer, '0.5'),
      pay(FUND, xrp('50'), `propose:${JSON.stringify({ c: MOO, i: ISSUER, n: 'Moo' })}`, { from: ISSUER, issuerFlags: signs }),
      pay(FUND, xrp('5'), 'propose:{"c":', { from: BOB }),
      lock3,
      pay(FUND, xrp('0.0005'), 'blume:fee:0123456789abcdef'),
    ]
    balance = dec.add(balance, inflow(first))
    s = applyView(s, view(s, first, snapshot()), NOW + 1000).state
    balance = dec.sub(balance, executeFundingActions(s))

    // --- view 2: the waiting lock's sender pays to take it back; a payment still aimed at a funding round
    const second = [pay(FUND, xrp('0.25'), `return:${lock3.tx}`), pay(FUND, xrp('10'), 'round:MOO', { from: BOB })]
    balance = dec.add(balance, inflow(second))
    s = applyView(s, view(s, second, snapshot()), NOW + 2000).state
    balance = dec.sub(balance, executeFundingActions(s))

    // revenue: 1 (fee) + 50 (listing) + 1 (refusal keeps) + 0.25 (return fee) + 0.0005 (too small to send back)
    expect(s.fees.xrp).toBe('52.2505')
    // and nothing else is the bridge's: what came back to payers left the account in full, its network fees included
    expect(dec.sub(balance, B0)).toBe('52.2505')

    // --- the payout: the lock account is topped up first, then the rest is split 70/30
    const paid = tick(s, NOW + 700_000)
    s = paid.state
    const [entry] = s.fees.payouts
    const batch = s.actions[entry.actionId]
    // the reserve counts the new listing's trust line already: signer list, PETAL and MOO is 3 objects, 1.6 XRP; 2 held leaves 0.4 free against a floor of 10
    expect(entry.shares.map((sh) => [sh.to, sh.xrp, sh.role])).toEqual([
      [LOCK, '9.6', 'lock'],
      ['rOpA', '9.951783', 'operator'],
      ['rOpB', '9.951783', 'operator'],
      ['rOpC', '9.951783', 'operator'],
      [TREASURY, '12.795151', 'treasury'],
    ])
    batch.inner = batch.inner!.map((slot, i) => ({ ...slot, hash: `P${i}`, result: 'tesSUCCESS' }))
    batch.status = 'validated'
    settlePayout(s, batch, NOW + 701_000)
    balance = dec.sub(balance, leaves(batch))

    // everything the books say closes with what the account holds: 52.2505 taken, 52.2505 paid out, and the batch's own fee of 0.001 on top
    expect(s.fees.paidXrp).toBe('52.2515')
    expect(dec.sub(balance, B0)).toBe(dec.add(dec.sub(s.fees.xrp, s.fees.paidXrp), s.treasuryXrp))
    expect(dec.sub(balance, B0)).toBe('-0.001')
    // nobody is owed anything and nothing is left in the pool
    expect(s.fees.owed).toEqual({})
    // the lock account now holds its floor: 2 + 9.6 against a reserve of 1.6 and a floor of 10
    expect(dec.sub(dec.sub(dec.add(lockBalance, entry.shares[0].xrp), '1.6'), '10')).toBe('0')
    // the lock that was taken back is the lock account's to send, not the funding account's, and the return fee that paid for it is revenue above
    const lockBack = Object.values(s.actions).find((a) => a.account === 'lock' && a.reason.kind === 'return')!
    expect(lockBack.tx).toMatchObject({ Destination: ALICE, Amount: petal() })
  })

  it('also when the treasury share stays in the account', () => {
    let s = baseState()
    for (const [i, n] of ['edAAA', 'edBBB', 'edCCC'].entries()) s.operators[n] = { node: n, xrplAddress: 'rNode' + n, xrplPublicKey: 'ED' + n, evmAddress: '0x' + n, payoutAddress: ['rOpA', 'rOpB', 'rOpC'][i] }
    const B0 = '100'
    const i1 = intent(s, { id: 'b1b1b1b1b1b1b1b1', amount: '5' })
    s = i1.state
    const events = [feeOf(i1.transfer, '1.5'), lockOf(i1.transfer, petal('5')), pay(FUND, xrp('50'), `propose:${JSON.stringify({ c: MOO, i: ISSUER })}`, { from: ISSUER, issuerFlags: signs })]
    let balance = dec.add(B0, '51.5')
    s = applyView(s, view(s, events, accounts(10, 20, '100000000', dec.toDrops(balance))), NOW + 1000).state
    expect(s.fees.xrp).toBe('51.5')
    const paid = tick(s, NOW + 700_000)
    s = paid.state
    const [entry] = s.fees.payouts
    const batch = s.actions[entry.actionId]
    batch.inner = batch.inner!.map((slot, i) => ({ ...slot, hash: `P${i}`, result: 'tesSUCCESS' }))
    batch.status = 'validated'
    settlePayout(s, batch, NOW + 701_000)
    balance = dec.sub(balance, leaves(batch))
    // no top-up (the lock account holds plenty), the treasury share kept where it is: 51.5 in, 36.049998 paid out, 15.450002 kept in place
    expect(entry.shares.some((sh) => sh.role === 'lock')).toBe(false)
    expect(s.treasuryXrp).toBe('15.450002')
    expect(dec.sub(balance, B0)).toBe(dec.add(dec.sub(s.fees.xrp, s.fees.paidXrp), s.treasuryXrp))
  })

  // A fee that came in short goes straight back. When that return fails for good the XRP it carried stays in the funding account, so it is booked as revenue,
  // and the books follow the balance: the amount, and the network fee as well when the ledger never took it.
  for (const how of ['refused by the ledger', 'never validated']) {
    it(`also when a return fails for good: ${how}`, () => {
      const B0 = '100'
      const i1 = intent(baseState(), { id: 'c1c1c1c1c1c1c1c1' })
      let s = i1.state
      let balance = dec.add(B0, '0.5')
      s = applyView(s, view(s, [feeOf(i1.transfer, '0.5')], accounts(10, 20, '100000000', dec.toDrops(balance))), NOW + 1000).state
      const back = Object.values(s.actions).find((a) => a.reason.kind === 'return')!
      expect(back).toMatchObject({ account: 'funding', status: 'pending' })
      expect(back.tx).toMatchObject({ Destination: ALICE, Amount: '499000' })
      if (how === 'refused by the ledger') {
        s = applyView(s, view(s, [{ ...outgoing(FUND, back.sequence!, 'tecNO_DST'), destination: ALICE, amount: xrp('0.499') }], accounts(10, 21, '100000000', dec.toDrops(balance))), NOW + 2000).state
        // the ledger took the network fee and delivered nothing
        balance = dec.sub(balance, dec.fromDrops(String(back.tx.Fee)))
        expect(s.actions[back.id].status).toBe('failed')
      } else {
        for (let n = 0; n < 3; n++) {
          const open = Object.values(s.actions).find((a) => a.reason.kind === 'return' && a.status === 'pending')!
          const far = { ...s, cursor: { ...s.cursor, xrpl: { ledger: open.lastLedger! + 1, seen: [] } } }
          s = applyView(far, view(far, []), NOW + 2000 + n).state
        }
        expect(Object.values(s.actions).filter((a) => a.reason.kind === 'return').map((a) => a.status)).toEqual(['expired', 'expired', 'expired'])
      }
      expect(s.fees.xrp).toBe(how === 'refused by the ledger' ? '0.499' : '0.5')
      expect(dec.sub(balance, B0)).toBe(dec.add(dec.sub(s.fees.xrp, s.fees.paidXrp), s.treasuryXrp))
    })
  }
})
