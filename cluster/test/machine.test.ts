import { describe, expect, it } from 'vitest'
import { Wallet } from 'xrpl'
import { toTransfer } from '../src/api'
import { applyEvmView, applyKeys, applyView, createIntent, createTestBurn, queueEvmWork, tick, validateIntent, validateTestBurn } from '../src/machine'
import { returnSrcTxOf, srcTxOf, tokenIdOf } from '../src/evm'
import { startCollector, tally, voteWaitMs, VOTE_SLACK_MS, type ViewVote } from '../src/vote'
import { canon, hashOf } from '../src/canon'
import * as dec from '../src/dec'
import type { State, TransferRec, XrplView } from '../src/types'
import genesis from '../genesis/dev.json'
import { ALICE, BOB, DAY, EVM, FUND, LOCK, NOW, accounts, baseState, evmState, feeOf, intent, lockOf, outgoing, pay, petal, view, xrp } from './helpers'

const base = baseState
/** type(uint256).max, what the v3 minter calls no limit. */
const UNCAPPED = (2n ** 256n - 1n).toString()
const evmBase = evmState
const evmView = (s: State, events: any[], listings: Record<string, { token: string; dailyCapWei: string }> = {}) => ({ src: 'evm' as const, from: s.cursor.evm!.block, to: s.cursor.evm!.block + 10, events, listings })

describe('dec', () => {
  it('round-trips and does ratio math', () => {
    expect(dec.add('0.1', '0.2')).toBe('0.3')
    expect(dec.mulRatio('1000', 3, 1000)).toBe('3')
    expect(dec.fromDrops('600000000')).toBe('600')
    expect(dec.toDrops('1.5')).toBe('1500000')
    expect(dec.cmp('1e-10', '0')).toBe(1)
  })
})

describe('locks', () => {
  it('attaches a lock to its intent and moves it to attesting', () => {
    const { state: s1, transfer } = intent(base(), { id: 'abcdefabcdefabcd', sym: 'petal' })
    expect(transfer.step).toBe(1)
    expect(transfer.memo).toBe(`blume:abcdefabcdefabcd:${EVM}`)
    const lock = lockOf(transfer)
    const { state: s2, applied } = applyView(s1, view(s1, [feeOf(transfer), lock]), NOW + 1000)
    const t = s2.transfers[transfer.id]
    expect(t.step).toBe(3)
    expect(t.srcTx).toBe(lock.tx)
    expect(t.receive).toBe('1000')
    expect(s2.tokens.PETAL.lockedUnits).toBe('1000')
    expect(s2.tokens.PETAL.dustUnits).toBe('0')
    expect(s2.cursor.xrpl.ledger).toBe(105)
    expect(applied.map((a) => a.kind)).toEqual(['fee', 'lock'])
  })
  it('a bare 0x memo names no intent and never mints', () => {
    const s = base()
    const { state } = applyView(s, view(s, [pay(LOCK, petal(), EVM), pay(LOCK, petal(), `blume:${EVM}`)]), NOW)
    expect(Object.keys(state.transfers)).toHaveLength(0)
    expect(state.unmatched.map((u) => u.reason)).toEqual(['no-intent', 'no-intent'])
    expect(state.tokens.PETAL.lockedUnits).toBe('0')
  })
  it('records a lock whose memo names nothing as unmatched', () => {
    const s = base()
    const { state } = applyView(s, view(s, [pay(LOCK, petal(), 'hello')]), NOW)
    expect(Object.keys(state.transfers)).toHaveLength(0)
    expect(state.unmatched[0].reason).toBe('no-intent')
  })
  it('fails a lock over the cap without counting it and queues its refund', () => {
    const { state: s, transfer } = intent(base())
    s.tokens.PETAL.capUnits = '500'
    const { state } = applyView(s, view(s, [feeOf(transfer), lockOf(transfer)]), NOW)
    const t = state.transfers[transfer.id]
    expect(t.failed).toBe('cap')
    expect(state.tokens.PETAL.lockedUnits).toBe('0')
    const refund = state.actions[t.refundActionId!]
    expect(refund.reason).toEqual({ kind: 'return', tx: t.srcTx, to: ALICE })
    expect(refund.account).toBe('lock')
    expect((refund.tx as any).Destination).toBe(ALICE)
    expect((refund.tx as any).Amount).toEqual({ currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '1000' })
    // promoted, then validated by the ledger
    const s2 = applyView(state, view(state, []), NOW).state
    expect(s2.actions[refund.id].sequence).toBe(10)
    const s3 = applyView(s2, view(s2, [{ ...outgoing(LOCK, 10), destination: ALICE, amount: petal() }], accounts(11)), NOW).state
    expect(s3.actions[refund.id].status).toBe('validated')
    expect(s3.transfers[t.id].refundTx).toMatch(/^OUT/)
  })
  it('refuses the zero address and dust', () => {
    const s = base()
    const { state } = applyView(s, view(s, [pay(LOCK, petal(), '0x0000000000000000000000000000000000000000'), pay(LOCK, { ...petal(), value: '0.00000000000000000001' }, EVM)]), NOW)
    expect(Object.keys(state.transfers)).toHaveLength(0)
    expect(state.unmatched.map((u) => u.reason)).toEqual(['no-intent', 'dust'])
    expect(validateIntent(s, { dir: 'in', sym: 'PETAL', amount: '1', from: ALICE, to: '0x0000000000000000000000000000000000000000' })).toMatchObject({ ok: false })
  })
  it('mirrors the minter: gross units minted per UTC day are capped, not just the net outstanding', () => {
    const s = evmBase()
    s.tokens.PETAL.evmAddress = '0x1111111111111111111111111111111111111111'
    s.tokens.PETAL.capUnits = '1000'
    const day0 = Math.floor(NOW / DAY) * DAY + 1000
    const bridgeIn = (st: State, id: string, now: number) => {
      const i = intent(st, { id, amount: '600' })
      const r = applyView(i.state, view(i.state, [feeOf(i.transfer), lockOf(i.transfer, petal('600'))]), now)
      return { state: r.state, transfer: r.state.transfers[id] }
    }
    const a = bridgeIn(s, '1111111111111111', day0)
    expect(a.state.tokens.PETAL.lockedUnits).toBe('600')
    expect(a.state.tokens.PETAL.mintedToday).toBe('600')
    // a burn brings the net down, but the day's gross stays
    const b = applyEvmView(a.state, evmView(a.state, [{ kind: 'burn', tx: '0xb', block: 1002, logIndex: 0, token: '0x1111111111111111111111111111111111111111', from: EVM, amountWei: '500000000000000000000', rAddress: ALICE, nonce: '1' }]), day0).state
    expect(b.tokens.PETAL.lockedUnits).toBe('100')
    const c = bridgeIn(b, '2222222222222222', day0 + 1)
    expect(c.transfer.failed).toBe('cap')
    expect(c.transfer.refundActionId).toBeDefined()
    expect(c.state.tokens.PETAL.lockedUnits).toBe('100')
    // the next UTC day starts a fresh bucket
    const d = bridgeIn(c.state, '3333333333333333', day0 + DAY)
    expect(d.transfer.failed).toBeUndefined()
    expect(d.transfer.step).toBe(3)
    expect(d.state.tokens.PETAL.mintedToday).toBe('600')
    expect(d.state.tokens.PETAL.mintDay).toBe(Math.floor((day0 + DAY) / DAY))
  })
  it('ignores a replayed tx', () => {
    const { state: s, transfer } = intent(base())
    const events = [feeOf(transfer), lockOf(transfer)]
    const a = applyView(s, view(s, events), NOW)
    const b = applyView(a.state, { ...view(a.state, events) }, NOW)
    expect(Object.keys(b.state.transfers)).toHaveLength(1)
    expect(b.state.tokens.PETAL.lockedUnits).toBe('1000')
    expect(b.state.fees.xrp).toBe('1')
  })
  it('refuses a view that does not start at the cursor', () => {
    const s = base()
    expect(() => applyView(s, { src: 'xrpl', from: 90, to: 95, events: [], accounts: accounts() }, NOW)).toThrow()
  })
})

describe('listings', () => {
  const lockedForGood = { noFreeze: false, globalFreeze: false, requireAuth: false, clawback: false, defaultRipple: true, disableMaster: true, blackholed: true }
  it('lists a token at once from a valid proposal and books the fee as revenue', () => {
    const s = base()
    const ev = pay(FUND, xrp('50'), `propose:moo:4D4F4F0000000000000000000000000000000000:${BOB}:900:Moo Token`, { issuerFlags: lockedForGood })
    const { state, applied } = applyView(s, view(s, [ev]), NOW)
    expect(applied[0].kind).toBe('listing')
    const moo = state.tokens.MOO
    // an issuer locked for good can never sign a freeze, NoFreeze or not
    expect(moo).toMatchObject({ status: 'listed', lane: 'community', issuerLocked: true, noFreezeUnset: false, name: 'Moo Token', capUnits: '0', listedAt: NOW, trustLine: 'pending', lockedUnits: '0', dustUnits: '0' })
    // the 50 XRP are fee revenue like any other, not a pile the treasury keeps aside
    expect(state.fees.xrp).toBe('50')
    expect(state.fees.xrpByToken).toEqual({ MOO: '50' })
    expect(state.treasuryXrp).toBe('0')
    const trust = Object.values(state.actions).find((x) => x.reason.kind === 'trustline')
    expect(trust?.kind).toBe('xrpl.trustset')
    expect(trust?.status).toBe('pending')
    expect(trust?.sequence).toBe(10)
    expect((trust?.tx as any).LimitAmount.currency).toBe('4D4F4F0000000000000000000000000000000000')
    expect(state.accounts[LOCK].inflight).toBe(trust?.id)
  })
  it('rejects proposals with clawback, a short fee, or an unread issuer', () => {
    const s = base()
    const ok = { noFreeze: true, globalFreeze: false, requireAuth: false, clawback: false, defaultRipple: true, disableMaster: true, blackholed: true }
    const { state } = applyView(s, view(s, [
      pay(FUND, xrp('50'), `propose:AAA:AAA:${BOB}`, { issuerFlags: { ...ok, clawback: true } }),
      pay(FUND, xrp('49'), `propose:BBB:BBB:${BOB}`, { issuerFlags: ok }),
      pay(FUND, xrp('50'), `propose:CCC:CCC:${BOB}`, { issuerFlags: null }),
      pay(FUND, xrp('50'), `propose:DDD:DDD:notanaddress`, { issuerFlags: ok }),
      pay(FUND, xrp('50'), `propose:PETAL:${genesis.tokens.PETAL.currency}:${genesis.tokens.PETAL.issuer}`, { issuerFlags: ok }),
    ]), NOW)
    expect(state.unmatched.map((u) => u.reason)).toEqual(['propose:clawback', 'propose:fee', 'propose:issuer-unread', 'propose:bad-issuer', 'propose:exists'])
    expect(Object.keys(state.tokens)).toHaveLength(2)
    // each refusal keeps 1 XRP as revenue and sends the rest back
    expect(state.fees.xrp).toBe('5')
  })
  it('stores a hex currency in upper case however it was typed', () => {
    const s = base()
    const ev = pay(FUND, xrp('50'), `propose:moo:4d4f4f0000000000000000000000000000000000:${BOB}:900:Moo`, { issuerFlags: lockedForGood })
    const { state } = applyView(s, view(s, [ev]), NOW)
    expect(state.tokens.MOO.currency).toBe('4D4F4F0000000000000000000000000000000000')
  })
  it('expires stale intents', () => {
    const s0 = base()
    const v = validateIntent(s0, { dir: 'in', sym: 'PETAL', amount: '1', from: ALICE, to: EVM })
    if (!v.ok) throw new Error(v.error)
    const { state } = createIntent(s0, v.intent, '0123456789abcdef', NOW)
    expect(tick(state, NOW + 1).state.transfers['0123456789abcdef'].failed).toBeUndefined()
    // an inbound intent is kept, marked expired, in case its Batch is still on the way
    expect(tick(state, NOW + genesis.config.intentTtlMs + 1).state.transfers['0123456789abcdef']).toMatchObject({ step: 1, failed: 'expired' })
  })
})

describe('actions', () => {
  it('a test burn queues a release from the lock account and it settles the transfer', () => {
    const s0 = base()
    s0.tokens.PETAL.lockedUnits = '100'
    const v = validateTestBurn(s0, { sym: 'petal', amount: '40', to: ALICE })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const { state: s1, transfer, action } = createTestBurn(s0, v, 'feedfacefeedface', NOW)
    expect(transfer.dir).toBe('out')
    expect(transfer.step).toBe(3)
    expect(transfer.receive).toBe('40')
    expect(action.status).toBe('queued')
    expect((action.tx as any).Destination).toBe(ALICE)
    expect((action.tx as any).Amount).toEqual({ currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '40' })
    expect((action.tx as any).Fee).toBe('1000')
    const s2 = applyView(s1, view(s1, []), NOW).state
    expect(s2.actions[action.id].status).toBe('pending')
    expect(s2.actions[action.id].sequence).toBe(10)
    const s3 = applyView(s2, view(s2, [outgoing(LOCK, 10)], accounts(11)), NOW).state
    expect(s3.actions[action.id].status).toBe('validated')
    expect(s3.transfers[transfer.id].step).toBe(5)
    expect(s3.transfers[transfer.id].done).toBe(true)
    expect(s3.transfers[transfer.id].dstTx).toMatch(/^OUT/)
  })
  it('a refused transaction holds the transfer instead of failing it; an expired one is retried with a new sequence', () => {
    const s0 = base()
    s0.tokens.PETAL.lockedUnits = '100'
    const v = validateTestBurn(s0, { sym: 'PETAL', amount: '1', to: ALICE })
    if (!v.ok) throw new Error(v.error)
    const { state: s1, transfer, action } = createTestBurn(s0, v, 'feedfacefeedfac1', NOW)
    const s2 = applyView(s1, view(s1, []), NOW).state
    const failed = applyView(s2, view(s2, [outgoing(LOCK, 10, 'tecPATH_DRY')], accounts(11)), NOW).state
    expect(failed.actions[action.id].status).toBe('failed')
    expect(failed.transfers[transfer.id].failed).toBeUndefined()
    expect(failed.transfers[transfer.id].held).toEqual({ since: NOW, result: 'tecPATH_DRY', attempts: 1, retryAt: NOW + 60000 })
    // expiry: no outgoing event before lastLedger
    const far = { ...s2, cursor: { xrpl: { ledger: s2.actions[action.id].lastLedger! + 1, seen: [] } } }
    const e = applyView(far, view(far, []), NOW).state
    expect(e.actions[action.id].status).toBe('expired')
    const retry = Object.values(e.actions).find((a) => a.reason.kind === 'release' && a.attempts === 1)
    expect(retry?.status).toBe('pending')
    expect(retry?.sequence).toBe(10)
    expect(e.transfers[transfer.id].actionId).toBe(retry?.id)
  })
  it('only one action per account is in flight; the rest wait', () => {
    const s0 = base()
    const a = createTestBurn(s0, { sym: 'PETAL', amount: '1', to: ALICE, from: EVM }, 'aaaaaaaaaaaaaaaa', NOW).state
    const b = createTestBurn(a, { sym: 'PETAL', amount: '2', to: BOB, from: EVM }, 'bbbbbbbbbbbbbbbb', NOW + 1).state
    const c = applyView(b, view(b, []), NOW).state
    const statuses = Object.values(c.actions).map((x) => x.status).sort()
    expect(statuses).toEqual(['pending', 'queued'])
    const d = applyView(c, view(c, [outgoing(LOCK, 10)], accounts(11)), NOW).state
    const second = Object.values(d.actions).find((x) => x.status === 'pending')
    expect(second?.sequence).toBe(11)
  })
  it('rejects test burns when hooks are off, the token is not listed, or more is asked than is locked', () => {
    const s = base()
    s.tokens.PETAL.lockedUnits = '10'
    expect(validateTestBurn({ ...s, config: { ...s.config, testHooks: false } }, { sym: 'PETAL', amount: '1', to: ALICE }).ok).toBe(false)
    expect(validateTestBurn(s, { sym: 'GLDN', amount: '1', to: ALICE }).ok).toBe(false)
    expect(validateTestBurn(s, { sym: 'PETAL', amount: '20', to: ALICE })).toMatchObject({ ok: false, error: 'only 10 PETAL is locked' })
    expect(validateTestBurn(s, { sym: 'PETAL', amount: '10', to: ALICE }).ok).toBe(true)
  })
  it('an outgoing transaction that only took the sequence does not settle the action; it goes back in the queue', () => {
    const s0 = base()
    const a = createTestBurn(s0, { sym: 'PETAL', amount: '1', to: ALICE, from: EVM }, 'cccccccccccccccc', NOW)
    const s1 = applyView(a.state, view(a.state, []), NOW).state
    expect(s1.actions[a.action.id].sequence).toBe(10)
    // the master key sent something else at sequence 10
    const stranger = { ...outgoing(LOCK, 10), destination: BOB, amount: { currency: 'XRP', value: '5' } }
    const s2 = applyView(s1, view(s1, [stranger], accounts(11)), NOW)
    expect(s2.applied.map((x) => x.kind)).toContain('action.collided')
    expect(s2.state.actions[a.action.id].status).toBe('expired')
    expect(s2.state.actions[a.action.id].result).toContain('sequence taken')
    const retry = Object.values(s2.state.actions).find((x) => x.status === 'pending')!
    expect(retry.id).not.toBe(a.action.id)
    expect(retry.sequence).toBe(11)
    expect(retry.attempts).toBe(0)
    expect(s2.state.transfers[a.transfer.id].actionId).toBe(retry.id)
    expect(s2.state.transfers[a.transfer.id].done).toBe(false)
    // the real one, carrying our destination and amount, settles it
    const ours = { ...outgoing(LOCK, 11), destination: ALICE, amount: { currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '1' } }
    const s3 = applyView(s2.state, view(s2.state, [ours], accounts(12)), NOW).state
    expect(s3.actions[retry.id].status).toBe('validated')
    expect(s3.transfers[a.transfer.id].done).toBe(true)
    // a different transaction type at our sequence is a collision too
    const b = createTestBurn(s3, { sym: 'PETAL', amount: '1', to: ALICE, from: EVM }, 'dddddddddddddddd', NOW)
    const s4 = applyView(b.state, view(b.state, [], accounts(12)), NOW).state
    expect(s4.transfers[b.transfer.id].actionId && s4.actions[s4.transfers[b.transfer.id].actionId!].sequence).toBe(12)
    const s5 = applyView(s4, view(s4, [outgoing(LOCK, 12, 'tesSUCCESS', 'AccountSet')], accounts(13)), NOW)
    expect(s5.applied.map((x) => x.kind)).toContain('action.collided')
    expect(s5.state.transfers[b.transfer.id].done).toBe(false)
  })
})

describe('operators', () => {
  const unl = ['edAAA', 'edBBB', 'edCCC']
  const keys = (n: string) => ({ node: n, xrplAddress: 'r' + n, xrplPublicKey: 'ED' + n, evmAddress: '0x' + n })
  it('records the set only when every UNL node is in it', () => {
    const s = base()
    expect(applyKeys(s, [keys('edAAA'), keys('edBBB')], unl).applied).toHaveLength(0)
    const r = applyKeys(s, [keys('edCCC'), keys('edAAA'), keys('edBBB')], unl)
    expect(Object.keys(r.state.operators)).toEqual(['edAAA', 'edBBB', 'edCCC'])
    expect(applyKeys(r.state, [keys('edAAA'), keys('edBBB'), keys('edCCC')], unl).applied).toHaveLength(0)
  })
})

describe('evm side', () => {
  const PETAL_ID = tokenIdOf({ currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer })
  const PETAL_ADDR = '0x1111111111111111111111111111111111111111'
  it('queues a listing for every listed token without an ERC-20 once operators are known', () => {
    const s = evmBase()
    const applied = queueEvmWork(s, NOW)
    const lists = Object.values(s.evmActions).filter((a) => a.kind === 'list')
    expect(lists.map((a) => (a.reason as any).sym).sort()).toEqual(['PETAL', 'XRP'])
    expect(lists.every((a) => a.relayer >= 0 && a.relayer < 3)).toBe(true)
    expect(applied).toHaveLength(2)
    expect(queueEvmWork(s, NOW)).toHaveLength(0)
    const petal = lists.find((a) => (a.reason as any).sym === 'PETAL')!
    // PETAL carries its own cap from genesis (1,000,000); XRP has none in the dev genesis and takes the default
    expect(petal.data).toEqual({ tokenId: PETAL_ID, name: 'Petal', symbol: 'PETAL', imageURI: '', dailyCap: '1000000000000000000000000' })
    expect(lists.find((a) => (a.reason as any).sym === 'XRP')!.data.dailyCap).toBe('100000000000000000000000')
    // a newly listed token has capUnits '0' until the listing executes: the default, never an uncapped listing
    const s2 = evmBase()
    s2.tokens.PETAL.capUnits = '0'
    queueEvmWork(s2, NOW)
    expect(Object.values(s2.evmActions).find((a) => (a.reason as any).sym === 'PETAL')!.data.dailyCap).toBe('100000000000000000000000')
  })
  it('a token the minter already lists is adopted from the view instead of relisted', () => {
    const s = evmBase()
    s.cursor.evm!.synced = false
    expect(queueEvmWork(s, NOW)).toHaveLength(0)
    const r = applyEvmView(s, evmView(s, [], { [PETAL_ID]: { token: PETAL_ADDR, dailyCapWei: '5000000000000000000000' } }), NOW).state
    expect(r.tokens.PETAL.evmAddress).toBe(PETAL_ADDR)
    expect(r.tokens.PETAL.capUnits).toBe('5000')
    expect(r.cursor.evm!.synced).toBe(true)
    // type(uint256).max is the minter's no limit; a cap of 0 is no allowance at all
    const uncapped = applyEvmView(s, evmView(s, [], { [PETAL_ID]: { token: PETAL_ADDR, dailyCapWei: UNCAPPED } }), NOW).state
    expect(uncapped.tokens.PETAL.capUnits).toBeUndefined()
    const none = applyEvmView(s, evmView(s, [], { [PETAL_ID]: { token: PETAL_ADDR, dailyCapWei: '0' } }), NOW).state
    expect(none.tokens.PETAL.capUnits).toBe('0')
    expect(Object.values(r.evmActions).filter((a) => (a.reason as any).sym === 'PETAL')).toHaveLength(0)
    expect(Object.values(r.evmActions).filter((a) => (a.reason as any).sym === 'XRP')).toHaveLength(1)
  })
  it('a token listed at a cap of 0, which is where production puts every new listing, takes no deposits: the lock and its fee go back', () => {
    const s = evmBase()
    s.config = { ...s.config, params: { ...s.config.params, defaultCapUnits: '0' } }
    s.tokens.MOO = { sym: 'MOO', ticker: 'MOO', name: 'Moo', issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', currency: '4D4F4F0000000000000000000000000000000000', status: 'listed', lane: 'issuer', capUnits: '0', lockedUnits: '0', dustUnits: '0' }
    queueEvmWork(s, NOW)
    const list = Object.values(s.evmActions).find((a) => a.kind === 'list' && (a.reason as any).sym === 'MOO')!
    expect(list.data.dailyCap).toBe('0')
    const MOO_ID = tokenIdOf(s.tokens.MOO)
    const MOO_ADDR = '0x2222222222222222222222222222222222222222'
    const listed = applyEvmView(s, evmView(s, [{ kind: 'listed', tx: '0xl', block: 1005, logIndex: 0, tokenId: MOO_ID, token: MOO_ADDR, symbol: 'MOO', dailyCapWei: '0' }]), NOW).state
    // the minter will mint none of it, so the cluster does not take it
    expect(listed.tokens.MOO.capUnits).toBe('0')
    const i = intent(listed, { id: 'c0c0c0c0c0c0c0c0', sym: 'MOO', amount: '10' })
    const lock = lockOf(i.transfer, { currency: '4D4F4F0000000000000000000000000000000000', issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', value: '10' })
    const { state } = applyView(i.state, view(i.state, [feeOf(i.transfer), lock]), NOW + 1000)
    expect(state.transfers[i.transfer.id]).toMatchObject({ failed: 'cap' })
    expect(state.tokens.MOO.lockedUnits).toBe('0')
    expect(state.fees.xrp).toBe('0')
    expect(Object.values(state.actions).filter((a) => a.reason.kind === 'return')).toHaveLength(2)
  })
  it('a metadata update carries the cap the token has, and UNCAPPED for a token the cluster does not cap, never 0', () => {
    const s = evmBase()
    s.tokens.PETAL.evmAddress = PETAL_ADDR
    s.tokens.PETAL.capUnits = '5000'
    s.tokens.PETAL.metaVersion = 1
    s.tokens.XRP.evmAddress = '0x2222222222222222222222222222222222222222'
    s.tokens.XRP.metaVersion = 1
    delete s.tokens.XRP.capUnits
    queueEvmWork(s, NOW)
    const updates = Object.values(s.evmActions).filter((a) => a.kind === 'update')
    const cap = (sym: string) => updates.find((a) => (a.reason as any).sym === sym)!.data.dailyCap
    expect(cap('PETAL')).toBe('5000000000000000000000')
    expect(cap('XRP')).toBe(UNCAPPED)
    // and a cap of 0 the cluster set itself stays 0
    s.tokens.PETAL.capUnits = '0'
    delete s.tokens.PETAL.evmUpdateActionId
    queueEvmWork(s, NOW)
    expect(Object.values(s.evmActions).filter((a) => a.kind === 'update' && (a.reason as any).sym === 'PETAL').at(-1)!.data.dailyCap).toBe('0')
  })
  it('a Listed event sets the ERC-20 address and cap and confirms the action', () => {
    const s = evmBase()
    queueEvmWork(s, NOW)
    const action = Object.values(s.evmActions).find((a) => (a.reason as any).sym === 'PETAL')!
    const r = applyEvmView(s, evmView(s, [{ kind: 'listed', tx: '0xabc', block: 1005, logIndex: 0, tokenId: PETAL_ID, token: PETAL_ADDR, symbol: 'PETAL', dailyCapWei: '100000000000000000000000' }]), NOW)
    expect(r.state.tokens.PETAL.evmAddress).toBe(PETAL_ADDR)
    expect(r.state.tokens.PETAL.capUnits).toBe('100000')
    expect(r.state.evmActions[action.id].status).toBe('confirmed')
    expect(r.state.cursor.evm!.block).toBe(1010)
  })
  it('an agreed lock becomes a mint action once the token has an ERC-20, and the Minted event completes it', () => {
    const { state: s, transfer } = intent(evmBase())
    s.tokens.PETAL.evmAddress = PETAL_ADDR
    const lock = lockOf(transfer)
    const a = applyView(s, view(s, [feeOf(transfer), lock]), NOW).state
    const t = Object.values(a.transfers)[0]
    expect(t.step).toBe(3)
    const b = tick(a, NOW).state
    const mint = Object.values(b.evmActions).find((x) => x.kind === 'mint')!
    expect(mint.data).toEqual({ tokenId: PETAL_ID, to: EVM, amount: '1000000000000000000000', srcTx: srcTxOf(lock.tx) })
    expect(b.transfers[t.id].evmActionId).toBe(mint.id)
    const c = applyEvmView(b, evmView(b, [{ kind: 'mint', tx: '0xdef', block: 1003, logIndex: 1, tokenId: PETAL_ID, to: EVM, amountWei: '1000000000000000000000', srcTx: srcTxOf(lock.tx) }]), NOW).state
    expect(c.transfers[t.id].step).toBe(5)
    expect(c.transfers[t.id].done).toBe(true)
    expect(c.transfers[t.id].dstTx).toBe('0xdef')
    expect(c.evmActions[mint.id].status).toBe('confirmed')
  })
  it('a Burn event creates an outbound transfer and queues its release', () => {
    const s = evmBase()
    s.tokens.PETAL.evmAddress = PETAL_ADDR
    s.tokens.PETAL.lockedUnits = '500'
    const r = applyEvmView(s, evmView(s, [{ kind: 'burn', tx: '0xb', block: 1002, logIndex: 0, token: PETAL_ADDR, from: EVM, amountWei: '10000000000000000000', rAddress: ALICE, nonce: '1' }]), NOW).state
    const t = Object.values(r.transfers)[0]
    expect(t.dir).toBe('out')
    expect(t.amount).toBe('10')
    expect(t.receive).toBe('10')
    expect(t.to).toBe(ALICE)
    expect(t.step).toBe(3)
    const rel = r.actions[t.actionId!]
    expect(rel.kind).toBe('xrpl.payment')
    expect((rel.tx as any).Amount).toEqual({ currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '10' })
    expect(r.tokens.PETAL.lockedUnits).toBe('490')
  })
  it('a burn to a bad address is minted back to the burner, not dropped, and never waits out the hold', () => {
    const s = evmBase()
    s.tokens.PETAL.evmAddress = PETAL_ADDR
    s.tokens.PETAL.lockedUnits = '500'
    const BURN_TX = '0x' + 'cd'.repeat(32)
    const burn = { kind: 'burn' as const, tx: BURN_TX, block: 1002, logIndex: 3, token: PETAL_ADDR, from: EVM, amountWei: '10000000000000000001', rAddress: 'nope', nonce: '1' }
    const burned = applyEvmView(s, evmView(s, [burn]), NOW)
    const t = Object.values(burned.state.transfers)[0]
    expect(burned.applied.map((a) => a.kind).filter((k) => k !== 'evm.list')).toEqual(['evm.burn.bad-destination'])
    // no release is queued, the burn is final (the supply and what backs it fell together), and the hold is already over
    expect(Object.keys(burned.state.actions)).toHaveLength(0)
    expect(t.failed).toBeUndefined()
    expect(t.held).toEqual({ since: NOW, result: 'bad-destination', attempts: 0, final: true })
    expect(burned.state.tokens.PETAL.lockedUnits).toBe('489.999999999999999999')
    expect(burned.state.tokens.PETAL.dustUnits).toBe('0.000000000000000001')
    const read = toTransfer(burned.state, t)
    expect(read.held).toEqual({ result: 'bad-destination', since: NOW, until: NOW, attempts: 0, returning: false })
    // the next round mints the whole burn back: the same amount, to the same address, keyed by the burn's tx and log index
    const ticked = tick(burned.state, NOW + 1000)
    expect(ticked.applied.map((a) => a.kind)).toEqual(['release.returned'])
    const back = ticked.state.transfers[t.id]
    const mint = ticked.state.evmActions[back.returnEvmActionId!]
    expect(mint.kind).toBe('mint')
    expect(mint.data).toEqual({ tokenId: tokenIdOf(ticked.state.tokens.PETAL), to: EVM, amount: '10000000000000000001', srcTx: returnSrcTxOf(BURN_TX, 3) })
    expect(back.returnKey).toBe(returnSrcTxOf(BURN_TX, 3))
    expect(ticked.state.tokens.PETAL.lockedUnits).toBe('500')
    expect(ticked.state.tokens.PETAL.dustUnits).toBe('0')
    expect(ticked.state.tokens.PETAL.mintedToday).toBe('10.000000000000000001')
    // once, however many rounds pass
    expect(tick(ticked.state, NOW + 2000).applied).toHaveLength(0)
    expect(Object.values(ticked.state.evmActions).filter((a) => a.kind === 'mint')).toHaveLength(1)
    // the Minted event ends the transfer as returned
    const minted = { kind: 'mint' as const, tx: '0xret', block: 1013, logIndex: 0, tokenId: mint.data.tokenId, to: EVM, amountWei: '10000000000000000001', srcTx: returnSrcTxOf(BURN_TX, 3) }
    const done = applyEvmView(ticked.state, evmView(ticked.state, [minted]), NOW + 3000)
    expect(done.applied.map((a) => a.kind)).toContain('evm.returned')
    expect(done.state.transfers[t.id]).toMatchObject({ failed: 'returned', returnTx: '0xret' })
    expect(done.state.evmActions[mint.id].status).toBe('confirmed')
  })
  it('two burns in one transaction are each minted back under their own key', () => {
    const s = evmBase()
    s.tokens.PETAL.evmAddress = PETAL_ADDR
    s.tokens.PETAL.lockedUnits = '500'
    const BURN_TX = '0x' + 'ee'.repeat(32)
    const burn = (logIndex: number, amountWei: string) => ({ kind: 'burn' as const, tx: BURN_TX, block: 1002, logIndex, token: PETAL_ADDR, from: EVM, amountWei, rAddress: 'nope', nonce: String(logIndex) })
    const burned = applyEvmView(s, evmView(s, [burn(1, '3000000000000000000'), burn(4, '5000000000000000000')]), NOW).state
    const ticked = tick(burned, NOW + 1000).state
    const mints = Object.values(ticked.evmActions).filter((a) => a.kind === 'mint')
    expect(mints.map((m) => m.data.amount).sort()).toEqual(['3000000000000000000', '5000000000000000000'])
    // the minter allows one mint per source: with the tx alone these two would have shared one
    expect(new Set(mints.map((m) => m.data.srcTx)).size).toBe(2)
    expect(mints.map((m) => m.data.srcTx).sort()).toEqual([returnSrcTxOf(BURN_TX, 1), returnSrcTxOf(BURN_TX, 4)].sort())
    // and each Minted event finds its own transfer
    const minted = (logIndex: number, amountWei: string) => ({ kind: 'mint' as const, tx: '0xm' + logIndex, block: 1013, logIndex, tokenId: tokenIdOf(ticked.tokens.PETAL), to: EVM, amountWei, srcTx: returnSrcTxOf(BURN_TX, logIndex) })
    const done = applyEvmView(ticked, evmView(ticked, [minted(1, '3000000000000000000'), minted(4, '5000000000000000000')]), NOW + 2000).state
    const byAmount = Object.fromEntries(Object.values(done.transfers).map((t) => [t.amount, t]))
    expect(byAmount['3']).toMatchObject({ failed: 'returned', returnTx: '0xm1' })
    expect(byAmount['5']).toMatchObject({ failed: 'returned', returnTx: '0xm4' })
    expect(done.tokens.PETAL.lockedUnits).toBe('500')
  })
  it('a bad-address burn waits for a day with room under the cap, like any other return', () => {
    const s = evmBase()
    s.tokens.PETAL.evmAddress = PETAL_ADDR
    s.tokens.PETAL.lockedUnits = '500'
    s.tokens.PETAL.capUnits = '1000'
    const burned = applyEvmView(s, evmView(s, [{ kind: 'burn', tx: '0x' + 'ab'.repeat(32), block: 1002, logIndex: 0, token: PETAL_ADDR, from: EVM, amountWei: '10000000000000000000', rAddress: 'nope', nonce: '1' }]), NOW).state
    burned.tokens.PETAL.mintDay = Math.floor(NOW / DAY)
    burned.tokens.PETAL.mintedToday = '995'
    expect(tick(burned, NOW + 1000).applied).toHaveLength(0)
    const nextDay = (Math.floor(NOW / DAY) + 1) * DAY
    expect(tick(burned, nextDay).applied.map((a) => a.kind)).toEqual(['release.returned'])
  })
  it('rotates the relayer after the timeout, and keeps rotating a listing no matter how many tried', () => {
    const s = evmBase()
    queueEvmWork(s, NOW)
    const id = Object.keys(s.evmActions)[0]
    const first = s.evmActions[id].relayer
    let cur = s
    for (let i = 0; i < 5; i++) cur = applyEvmView(cur, evmView(cur, []), NOW + 30000).state
    expect(cur.evmActions[id].relayer).toBe(first)
    cur = applyEvmView(cur, evmView(cur, []), NOW + 60001).state
    expect(cur.evmActions[id].relayer).toBe((first + 1) % 3)
    let t = NOW + 60001
    for (let i = 0; i < 12; i++) {
      t += 60001
      cur = applyEvmView(cur, evmView(cur, []), t).state
    }
    // every operator has tried it several times over, and it is still pending: a listing is waited for, not given up on
    expect(cur.evmActions[id].status).toBe('pending')
    expect(cur.evmActions[id].attempts).toBeGreaterThan(3 * 3)
  })
})

describe('tally', () => {
  const v1: XrplView = { src: 'xrpl', from: 100, to: 105, events: [], accounts: accounts() }
  const v2: XrplView = { src: 'xrpl', from: 100, to: 105, events: [pay(FUND, xrp('999'), 'blume:fee:0123456789abcdef')], accounts: accounts() }
  const vote = (node: string, view: XrplView): ViewVote => ({ node, src: 'xrpl', hash: hashOf(view), view })
  it('picks the view k nodes agree on and ignores the odd one out', () => {
    const t = tally([vote('a', v1), vote('b', v1), vote('c', v2)], 2)
    expect(t.winner?.hash).toBe(hashOf(v1))
    expect(t.winner?.votes).toBe(2)
    expect(Object.keys(t.counts)).toHaveLength(2)
  })
  it('has no winner below k', () => {
    expect(tally([vote('a', v1), vote('b', v2)], 2).winner).toBeUndefined()
    expect(tally([vote('a', v1)], 2).winner).toBeUndefined()
  })
  it('counts one vote per node', () => {
    expect(tally([vote('a', v1), vote('a', v1)], 2).winner).toBeUndefined()
  })
})

describe('burn amounts', () => {
  const PETAL_ADDR = '0x1111111111111111111111111111111111111111'
  const XRP_ADDR = '0x2222222222222222222222222222222222222222'
  const burn = (token: string, amountWei: string, to = ALICE) => ({ kind: 'burn' as const, tx: '0xb' + amountWei, block: 1002, logIndex: 0, token, from: EVM, amountWei, rAddress: to, nonce: '1' })
  it('quantizes an 18-decimal IOU burn to what the ledger can sign and keeps the rest as surplus backing', () => {
    const s = evmBase()
    s.tokens.PETAL.evmAddress = PETAL_ADDR
    s.tokens.PETAL.lockedUnits = '500'
    const r = applyEvmView(s, evmView(s, [burn(PETAL_ADDR, '10000000000000000001')]), NOW).state
    const t = Object.values(r.transfers)[0]
    expect(t.amount).toBe('10.000000000000000001')
    expect(t.receive).toBe('10')
    expect(r.tokens.PETAL.dustUnits).toBe('0.000000000000000001')
    // what backs the supply fell by the whole burn, and the lock account holds the rest of it plus the surplus
    expect(r.tokens.PETAL.lockedUnits).toBe('489.999999999999999999')
    expect(dec.add(r.tokens.PETAL.lockedUnits, r.tokens.PETAL.dustUnits)).toBe(dec.sub('500', t.receive))
    const rel = r.actions[t.actionId!]
    expect((rel.tx as any).Amount.value).toBe('10')
    // the promoted transaction signs; the unquantized value would not
    const promoted = applyView(r, view(r, []), NOW).state.actions[rel.id]
    const w = Wallet.generate()
    expect(() => w.sign({ ...(promoted.tx as any), SigningPubKey: '' }, true)).not.toThrow()
    expect(() => w.sign({ ...(promoted.tx as any), Amount: { ...(promoted.tx as any).Amount, value: '10.000000000000000001' }, SigningPubKey: '' }, true)).toThrow(/precision/i)
  })
  it('quantizes an XRP burn to whole drops', () => {
    const s = evmBase()
    s.tokens.XRP.evmAddress = XRP_ADDR
    s.tokens.XRP.lockedUnits = '100'
    const r = applyEvmView(s, evmView(s, [burn(XRP_ADDR, '1234567890000000000')]), NOW).state
    const t = Object.values(r.transfers)[0]
    expect(t.receive).toBe('1.234567')
    expect((r.actions[t.actionId!].tx as any).Amount).toBe('1234567')
    expect(r.tokens.XRP.dustUnits).toBe('0.00000089')
    expect(r.tokens.XRP.lockedUnits).toBe('98.76543211')
    expect(dec.add(r.tokens.XRP.lockedUnits, r.tokens.XRP.dustUnits)).toBe(dec.sub('100', t.receive))
  })
  it('a zero burn or one below a drop is dust: no release, the lock account keeps it', () => {
    const s = evmBase()
    s.tokens.PETAL.evmAddress = PETAL_ADDR
    s.tokens.XRP.evmAddress = XRP_ADDR
    s.tokens.XRP.lockedUnits = '100'
    const r = applyEvmView(s, evmView(s, [burn(PETAL_ADDR, '0'), burn(XRP_ADDR, '100')]), NOW)
    const [zero, tiny] = Object.values(r.state.transfers)
    expect(zero.failed).toBe('dust')
    expect(tiny.failed).toBe('dust')
    expect(Object.keys(r.state.actions)).toHaveLength(0)
    expect(r.applied.filter((x) => x.kind === 'evm.burn.dust')).toHaveLength(2)
    expect(r.state.tokens.XRP.dustUnits).toBe('0.0000000000000001')
    // the burn was final, so what backs the supply fell with it; the sliver is surplus in the lock account
    expect(r.state.tokens.XRP.lockedUnits).toBe('99.9999999999999999')
  })
})

describe('held releases', () => {
  const PETAL_ADDR = '0x1111111111111111111111111111111111111111'
  const BURN_TX = '0x' + 'ab'.repeat(32)
  function burned(): { s: State; t: TransferRec } {
    const s = evmBase()
    s.tokens.PETAL.evmAddress = PETAL_ADDR
    s.tokens.PETAL.lockedUnits = '500'
    s.tokens.PETAL.capUnits = '1000'
    const r = applyEvmView(s, evmView(s, [{ kind: 'burn', tx: BURN_TX, block: 1002, logIndex: 0, token: PETAL_ADDR, from: EVM, amountWei: '10000000000000000000', rAddress: BOB, nonce: '1' }]), NOW).state
    return { s: r, t: Object.values(r.transfers)[0] }
  }
  const openRelease = (s: State, t: TransferRec) => Object.values(s.actions).find((a) => a.reason.kind === 'release' && (a.reason as any).transferId === t.id && (a.status === 'queued' || a.status === 'pending'))

  it('the release payment carries the burn tx in its memo', () => {
    const { s, t } = burned()
    const memo = (s.actions[t.actionId!].tx as any).Memos[0].Memo
    expect(Buffer.from(memo.MemoType, 'hex').toString()).toBe('blume/burn')
    expect(Buffer.from(memo.MemoData, 'hex').toString()).toBe(BURN_TX)
  })
  it('a tec release is retried after releaseRetryMs and the retry settles the transfer', () => {
    const { s, t } = burned()
    const s1 = applyView(s, view(s, []), NOW).state
    const s2 = applyView(s1, view(s1, [{ ...outgoing(LOCK, 10, 'tecNO_LINE'), destination: BOB, amount: { currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '10' } }], accounts(11)), NOW + 1000).state
    expect(s2.transfers[t.id].held).toMatchObject({ since: NOW + 1000, result: 'tecNO_LINE', attempts: 1, retryAt: NOW + 61000 })
    expect(openRelease(s2, t)).toBeUndefined()
    // nothing before the retry time
    const s3 = tick(s2, NOW + 30000).state
    expect(openRelease(s3, t)).toBeUndefined()
    expect(s3.transfers[t.id].held!.retryAt).toBe(NOW + 61000)
    // the retry: a fresh action, same destination and amount, and no second retry while it is open
    const s4 = tick(s3, NOW + 61000)
    expect(s4.applied.map((a) => a.kind)).toContain('release.retry')
    const retry = openRelease(s4.state, t)!
    expect(retry.id).not.toBe(t.actionId)
    expect((retry.tx as any).Destination).toBe(BOB)
    expect((retry.tx as any).Amount.value).toBe('10')
    expect(s4.state.transfers[t.id].actionId).toBe(retry.id)
    expect(s4.state.transfers[t.id].held!.retryAt).toBeUndefined()
    expect(tick(s4.state, NOW + 200000).applied.map((a) => a.kind)).not.toContain('release.retry')
    // bob added his trust line; the retry validates
    const s5 = applyView(s4.state, view(s4.state, [], accounts(11)), NOW + 62000).state
    expect(s5.actions[retry.id].sequence).toBe(11)
    const s6 = applyView(s5, view(s5, [{ ...outgoing(LOCK, 11), destination: BOB, amount: { currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '10' } }], accounts(12)), NOW + 65000).state
    expect(s6.transfers[t.id].done).toBe(true)
    expect(s6.transfers[t.id].held).toBeUndefined()
    expect(s6.transfers[t.id].failed).toBeUndefined()
  })

  it('a release the ledger keeps refusing waits twice as long each time, up to twelve times the base wait', () => {
    const { s, t } = burned()
    s.config.params.releaseHoldMs = 10 * 86_400_000 // longer than the whole run, so only the retry path is exercised
    const PAY = { destination: BOB, amount: { currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '10' } }
    const s1 = applyView(s, view(s, []), NOW).state
    let at = NOW + 1000
    let seqn = 10
    let st = applyView(s1, view(s1, [{ ...outgoing(LOCK, seqn, 'tecNO_LINE'), ...PAY }], accounts(seqn + 1)), at).state
    const waits: number[] = []
    for (let i = 0; i < 6; i++) {
      const held = st.transfers[t.id].held!
      waits.push(held.retryAt! - at)
      at = held.retryAt!
      st = tick(st, at).state // the retry is queued
      st = applyView(st, view(st, [], accounts(seqn + 1)), at + 500).state // and takes its sequence
      seqn++
      at += 1000
      st = applyView(st, view(st, [{ ...outgoing(LOCK, seqn, 'tecNO_LINE'), ...PAY }], accounts(seqn + 1)), at).state
    }
    expect(waits).toEqual([60000, 120000, 240000, 480000, 720000, 720000])
  })
  it('a release that never validated three times is held too', () => {
    const { s, t } = burned()
    let cur = applyView(s, view(s, []), NOW).state
    for (let i = 0; i < 3; i++) {
      const a = openRelease(cur, t)!
      const far = { ...cur, cursor: { ...cur.cursor, xrpl: { ledger: a.lastLedger! + 1, seen: [] } } }
      cur = applyView(far, view(far, []), NOW + i).state
    }
    expect(openRelease(cur, t)).toBeUndefined()
    expect(cur.transfers[t.id].held).toMatchObject({ result: 'expired', attempts: 1 })
  })
  it('when the hold runs out the tokens are minted back to the burner, once, against the cap and the day bucket', () => {
    const { s, t } = burned()
    const s1 = applyView(s, view(s, []), NOW).state
    const s2 = applyView(s1, view(s1, [{ ...outgoing(LOCK, 10, 'tecNO_LINE'), destination: BOB, amount: { currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '10' } }], accounts(11)), NOW).state
    // a retry in between also fails
    const s3 = tick(s2, NOW + 60000).state
    const s4 = applyView(s3, view(s3, [], accounts(11)), NOW + 60000).state
    const retry = openRelease(s4, t)!
    const s5 = applyView(s4, view(s4, [{ ...outgoing(LOCK, 11, 'tecNO_LINE'), destination: BOB, amount: { currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '10' } }], accounts(12)), NOW + 70000).state
    expect(s5.actions[retry.id].status).toBe('failed')
    expect(s5.transfers[t.id].held).toMatchObject({ since: NOW, attempts: 2 })
    // the hold (300 s in the dev genesis) is not over at 200 s: still retrying
    const s6 = tick(s5, NOW + 200000)
    expect(s6.applied.map((a) => a.kind)).toEqual(['release.retry'])
    const s7 = applyView(s6.state, view(s6.state, [], accounts(12)), NOW + 200000).state
    const third = openRelease(s7, t)!
    const s8 = applyView(s7, view(s7, [{ ...outgoing(LOCK, 12, 'tecNO_LINE'), destination: BOB, amount: { currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '10' } }], accounts(13)), NOW + 210000).state
    expect(s8.actions[third.id].status).toBe('failed')
    // past the hold: no more releases, one mint back to the burner with the burn tx as its source
    const s9 = tick(s8, NOW + 300001)
    expect(s9.applied.map((a) => a.kind)).toEqual(['release.returned'])
    const tr = s9.state.transfers[t.id]
    expect(openRelease(s9.state, t)).toBeUndefined()
    expect(tr.returnEvmActionId).toBeDefined()
    const mint = s9.state.evmActions[tr.returnEvmActionId!]
    expect(mint.kind).toBe('mint')
    expect(mint.data).toEqual({ tokenId: tokenIdOf({ currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer }), to: EVM, amount: '10000000000000000000', srcTx: returnSrcTxOf(BURN_TX, 0) })
    expect(s9.state.tokens.PETAL.lockedUnits).toBe('500')
    expect(s9.state.tokens.PETAL.mintedToday).toBe('10')
    expect(tr.failed).toBeUndefined()
    // idempotent: another tick queues nothing
    expect(tick(s9.state, NOW + 400000).applied).toHaveLength(0)
    expect(Object.values(s9.state.evmActions).filter((a) => a.kind === 'mint')).toHaveLength(1)
    // the Minted event ends the transfer as returned
    const s10 = applyEvmView(s9.state, evmView(s9.state, [{ kind: 'mint', tx: '0xret', block: 1013, logIndex: 0, tokenId: mint.data.tokenId, to: EVM, amountWei: '10000000000000000000', srcTx: returnSrcTxOf(BURN_TX, 0) }]), NOW + 400000)
    expect(s10.applied.map((a) => a.kind)).toContain('evm.returned')
    expect(s10.state.transfers[t.id].failed).toBe('returned')
    expect(s10.state.transfers[t.id].returnTx).toBe('0xret')
    expect(s10.state.transfers[t.id].done).toBe(false)
    expect(s10.state.evmActions[mint.id].status).toBe('confirmed')
  })
  it('gives back the whole burn, the part the ledger could not have carried included, and the surplus backs it again', () => {
    const s = evmBase()
    s.tokens.PETAL.evmAddress = PETAL_ADDR
    s.tokens.PETAL.lockedUnits = '500'
    s.tokens.PETAL.capUnits = '1000'
    const r = applyEvmView(s, evmView(s, [{ kind: 'burn', tx: BURN_TX, block: 1002, logIndex: 2, token: PETAL_ADDR, from: EVM, amountWei: '10000000000000000001', rAddress: BOB, nonce: '1' }]), NOW).state
    const t = Object.values(r.transfers)[0]
    expect(t.receive).toBe('10')
    expect(r.tokens.PETAL.lockedUnits).toBe('489.999999999999999999')
    expect(r.tokens.PETAL.dustUnits).toBe('0.000000000000000001')
    const s1 = applyView(r, view(r, []), NOW).state
    const failed = (sequence: number) => ({ ...outgoing(LOCK, sequence, 'tecNO_LINE'), destination: BOB, amount: { currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '10' } })
    const s2 = applyView(s1, view(s1, [failed(10)], accounts(11)), NOW).state
    // the hold (300 s in the dev genesis) runs out with the release still refused
    const s3 = tick(s2, NOW + 300001)
    expect(s3.applied.map((a) => a.kind)).toEqual(['release.returned'])
    const mint = s3.state.evmActions[s3.state.transfers[t.id].returnEvmActionId!]
    expect(mint.data.amount).toBe('10000000000000000001')
    expect(mint.data.srcTx).toBe(returnSrcTxOf(BURN_TX, 2))
    expect(s3.state.tokens.PETAL.lockedUnits).toBe('500')
    expect(s3.state.tokens.PETAL.dustUnits).toBe('0')
    expect(s3.state.tokens.PETAL.mintedToday).toBe('10.000000000000000001')
  })
  it('a transfer held before return keys existed is still found by its burn tx when its mint confirms', () => {
    const { s, t } = burned()
    delete t.srcLog
    s.transfers[t.id] = { ...t, held: { since: NOW, result: 'tecNO_LINE', attempts: 1 }, actionId: undefined }
    const s1 = tick(s, NOW + 300001).state
    const back = s1.transfers[t.id]
    expect(back.returnKey).toBe(srcTxOf(BURN_TX))
    const mint = { kind: 'mint' as const, tx: '0xold', block: 1013, logIndex: 0, tokenId: s1.evmActions[back.returnEvmActionId!].data.tokenId, to: EVM, amountWei: '10000000000000000000', srcTx: srcTxOf(BURN_TX) }
    expect(applyEvmView(s1, evmView(s1, [mint]), NOW + 300002).state.transfers[t.id].failed).toBe('returned')
  })
  it('the return waits for a day with room under the cap', () => {
    const { s, t } = burned()
    const s1 = applyView(s, view(s, []), NOW).state
    const s2 = applyView(s1, view(s1, [{ ...outgoing(LOCK, 10, 'tecNO_LINE'), destination: BOB, amount: { currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '10' } }], accounts(11)), NOW).state
    s2.tokens.PETAL.mintDay = Math.floor((NOW + 300001) / DAY)
    s2.tokens.PETAL.mintedToday = '995'
    // hold over, but the mint would push today over the cap: wait
    const s3 = tick(s2, NOW + 300001)
    expect(s3.applied).toHaveLength(0)
    expect(s3.state.transfers[t.id].returnEvmActionId).toBeUndefined()
    // the next UTC day has room
    const nextDay = (Math.floor((NOW + 300001) / DAY) + 1) * DAY
    const s4 = tick(s3.state, nextDay)
    expect(s4.applied.map((a) => a.kind)).toEqual(['release.returned'])
    expect(s4.state.tokens.PETAL.mintedToday).toBe('10')
  })
  it('a snapshot genesis restores the whole state', () => {
    const { s, t } = burned()
    const full = JSON.parse(JSON.stringify(s)) as State
    expect(full.transfers[t.id]).toBeDefined()
    expect(Object.keys(full.actions)).toHaveLength(1)
  })
})

describe('determinism', () => {
  it('applyKeys sees no change after the state is reloaded in canonical key order', () => {
    const s = base()
    const unl = ['edAAA', 'edBBB', 'edCCC']
    const keys = (n: string) => ({ node: n, xrplAddress: 'r' + n, xrplPublicKey: 'ED' + n, evmAddress: '0x' + n })
    const r = applyKeys(s, unl.map(keys), unl)
    expect(r.applied).toHaveLength(1)
    const reloaded: State = { ...r.state, operators: JSON.parse(canon(r.state.operators)) }
    expect(applyKeys(reloaded, unl.map(keys), unl).applied).toHaveLength(0)
  })
  it('dec rounds down to significant digits and to drops', () => {
    expect(dec.toSignificant('9.970000000000000001', 15)).toBe('9.97')
    expect(dec.toSignificant('123456789012345678.9', 15)).toBe('123456789012345000')
    expect(dec.toSignificant('0.000000000000000001', 15)).toBe('0.000000000000000001')
    expect(dec.toSignificant('1', 15)).toBe('1')
    expect(dec.floorToDrops('1.2345678')).toBe('1.234567')
    expect(dec.floorToDrops('0.0000001')).toBe('0')
  })
})

describe('voteWaitMs', () => {
  it('listens until a peer that spent its whole view budget has spoken, counted from the round start', () => {
    // A fast node done with its views 300 ms in still hears a peer whose EVM read takes its whole budget.
    expect(voteWaitMs(1000, 1300, 1500, 2400)).toBe(2400 + VOTE_SLACK_MS - 300)
  })
  it('never waits less than half a round after its own send', () => {
    expect(voteWaitMs(1000, 1000 + 3300, 1500, 2400)).toBe(1500)
  })
})

describe('vote', () => {
  const v1: XrplView = { src: 'xrpl', from: 100, to: 105, events: [], accounts: accounts() }
  const v2: XrplView = { src: 'xrpl', from: 100, to: 105, events: [pay(FUND, xrp('1'), 'blume:fee:0123456789abcdef')], accounts: accounts() }
  const vote = (node: string, view: XrplView): ViewVote => ({ node, src: 'xrpl', hash: hashOf(view), view })
  it('applies nothing when two different views both reach k', () => {
    const t = tally([vote('a', v1), vote('b', v1), vote('c', v2), vote('d', v2)], 2)
    expect(t.winner).toBeUndefined()
    expect(t.contested).toBe(true)
    expect(tally([vote('a', v1), vote('b', v1), vote('c', v2)], 2).winner?.hash).toBe(hashOf(v1))
  })
  it('the collector takes nothing from a node that votes twice for one source, but counts it as heard', async () => {
    let handler: ((node: { publicKey: string }, msg: Buffer) => void) | undefined
    const ctx = { publicKey: 'me', unl: { onMessage: (cb: typeof handler) => (handler = cb), send: async () => {}, count: () => 3 } }
    const c = startCollector(ctx, 7)
    const twice = { t: 'round', r: 7, views: [{ src: 'xrpl', hash: hashOf(v1), view: v1 }, { src: 'xrpl', hash: hashOf(v2), view: v2 }] }
    const once = { t: 'round', r: 7, views: [{ src: 'xrpl', hash: hashOf(v1), view: v1 }] }
    handler!({ publicKey: 'edX' }, Buffer.from(JSON.stringify(twice)))
    handler!({ publicKey: 'edY' }, Buffer.from(JSON.stringify(once)))
    const got = await c.collect(2, 50)
    expect(got.heard).toBe(2)
    expect(got.timedOut).toBe(false)
    expect(got.votes.map((v) => v.node)).toEqual(['edY'])
  })
})
