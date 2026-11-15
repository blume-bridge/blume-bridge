import { describe, expect, it } from 'vitest'
import { listTokens, listTransfers, toBridgeToken, toIntentReply, toOperators, toTransfer } from '../src/api'
import { applyEvmView, applyView, tick } from '../src/machine'
import { ALICE, BOB, EVM, FUND, LOCK, NOW, baseState, evmState, feeOf, hashOf64, intent, lockOf, petal, view } from './helpers'

/**
 * The shapes the site reads. The site is built against these, so a field that
 * appears, goes or changes type is a change to the site, and shows up here.
 */

const keysOf = (o: object) => Object.keys(o).sort()

describe('the operators read', () => {
  it('carries the cluster, its accounts, every fee the site quotes, and where the burn goes', () => {
    const s = evmState()
    const read = toOperators(s)
    expect(keysOf(read)).toEqual(['evmChainId', 'feeXrp', 'fundingAccount', 'issuerListingFeeXrp', 'k', 'listingsOpen', 'lockAccount', 'metaFeeXrp', 'minter', 'n', 'paused', 'ready', 'returnFeeXrp', 'signers'])
    expect(read).toMatchObject({ k: 2, n: 3, ready: true, lockAccount: LOCK, fundingAccount: FUND, feeXrp: '1', returnFeeXrp: '0.25', metaFeeXrp: '5', issuerListingFeeXrp: '50', listingsOpen: false, minter: s.config.evm!.minter, evmChainId: 1449000, paused: false })
    s.config.params.listingsOpen = true
    expect(toOperators(s).listingsOpen).toBe(true)
    expect(read.signers.map((x) => x.node)).toEqual(['edAAA', 'edBBB', 'edCCC'])
    expect(keysOf(read.signers[0])).toEqual(['evmAddress', 'node', 'xrplAddress', 'xrplPublicKey'])
  })
  it('fees are decimal strings, so the site can turn them to drops exactly', () => {
    const read = toOperators(baseState())
    for (const fee of [read.feeXrp, read.returnFeeXrp, read.metaFeeXrp, read.issuerListingFeeXrp]) expect(typeof fee).toBe('string')
  })
  it('minter and evmChainId are null on a cluster with no EVM side', () => {
    const read = toOperators(baseState())
    expect(read.minter).toBeNull()
    expect(read.evmChainId).toBeNull()
  })
  it('is not ready until every operator has published its keys', () => {
    const s = evmState()
    delete s.operators.edCCC
    expect(toOperators(s).ready).toBe(false)
  })
  it('names the issuer listing fee even when the config predates the parameter', () => {
    const s = baseState()
    delete s.config.params.issuerListingFeeXrp
    expect(toOperators(s).issuerListingFeeXrp).toBe('50')
  })
  it('no longer carries the old name for the name-change fee', () => {
    expect(toOperators(baseState())).not.toHaveProperty('proposalFeeXrp')
  })
})

describe('the token reads', () => {
  it('count the surplus as dustUnits, and know no feeUnits and no round', () => {
    const s = baseState()
    s.tokens.PETAL.dustUnits = '0.5'
    const read = toBridgeToken(s.tokens.PETAL)
    expect(read.dustUnits).toBe(0.5)
    expect(read).not.toHaveProperty('feeUnits')
    expect(read).not.toHaveProperty('round')
    expect(listTokens(s).every((t) => !('feeUnits' in t) && !('round' in t) && typeof t.dustUnits === 'number')).toBe(true)
  })
  it('carry the trust line limit the cluster recorded for a seed, and none for a token that has none', () => {
    const s = baseState()
    s.tokens.PETAL.trustLimit = '99980000000000'
    expect(toBridgeToken(s.tokens.PETAL).trustLimit).toBe('99980000000000')
    delete s.tokens.PETAL.trustLimit
    expect(toBridgeToken(s.tokens.PETAL).trustLimit).toBeUndefined()
  })
  it('say when a listing opens by itself, so a cap of 0 on it reads as "opening" and not as waiting for an operator', () => {
    const s = baseState()
    expect(toBridgeToken(s.tokens.PETAL).autoOpen).toBeUndefined()
    s.tokens.PETAL.autoOpen = true
    expect(toBridgeToken(s.tokens.PETAL).autoOpen).toBe(true)
  })
})

describe('the transfer read', () => {
  it('knows no fee mode and no fallback', () => {
    const i = intent(baseState())
    const read = toTransfer(i.state, i.transfer)
    expect(read).not.toHaveProperty('feeMode')
    expect(read).not.toHaveProperty('feeFallback')
    expect(read.feeXrp).toBe(1)
    expect(read.receive).toBe(1000)
  })
  it('carries awaitingFee with exactly the five things a wallet needs, while a lock waits for its fee', () => {
    const i = intent(baseState())
    const lock = lockOf(i.transfer, petal(), { tx: hashOf64(0xabc) })
    const s = applyView(i.state, view(i.state, [lock]), NOW + 1000).state
    const read = toTransfer(s, s.transfers[i.transfer.id])
    expect(keysOf(read.awaitingFee!)).toEqual(['feeMemo', 'feeTo', 'feeXrp', 'returnFeeXrp', 'returnMemo'])
    expect(read.awaitingFee).toEqual({ feeTo: FUND, feeMemo: `blume:fee:${i.transfer.id}`, feeXrp: '1', returnMemo: `return:${lock.tx}`, returnFeeXrp: '0.25' })
    expect(read.step).toBe(2)
    expect(read.feeTx).toBeUndefined()
    // and it follows the config: a fee moved after the quote is still the quote, the return fee is what is charged now
    const moved = { ...s, config: { ...s.config, params: { ...s.config.params, feeXrp: '3', returnFeeXrp: '0.5' } } }
    expect(toTransfer(moved, moved.transfers[i.transfer.id]).awaitingFee).toMatchObject({ feeXrp: '1', returnFeeXrp: '0.5' })
  })
  it('is read the same from the list as by id', () => {
    const i = intent(baseState())
    expect(listTransfers(i.state, { from: ALICE })).toEqual([toTransfer(i.state, i.transfer)])
    expect(listTransfers(i.state, { from: BOB })).toEqual([])
  })
  it('shows a burn held for a destination that is not an address as returning, with nothing left to wait out', () => {
    const s = evmState()
    s.tokens.PETAL.evmAddress = '0x1111111111111111111111111111111111111111'
    s.tokens.PETAL.lockedUnits = '50'
    const burn = { kind: 'burn' as const, tx: '0x' + 'ab'.repeat(32), block: 1002, logIndex: 0, token: s.tokens.PETAL.evmAddress, from: EVM, amountWei: '10000000000000000000', rAddress: 'nope', nonce: '1' }
    const burned = applyEvmView(s, { src: 'evm', from: s.cursor.evm!.block, to: s.cursor.evm!.block + 10, events: [burn], listings: {} }, NOW).state
    const queued = tick(burned, NOW + 1000).state
    const read = toTransfer(queued, Object.values(queued.transfers)[0])
    expect(read.held).toEqual({ result: 'bad-destination', since: NOW, until: NOW, attempts: 0, returning: true })
    expect(read.failed).toBeUndefined()
  })
})

describe('the answer to an intent', () => {
  it('always carries where to pay the fee, the memo it carries and its drops, pinned at the quote', () => {
    const i = intent(baseState())
    const reply = toIntentReply(i.state, i.transfer)
    expect(reply).toMatchObject({ memo: `blume:${i.transfer.id}:${EVM}`, payTo: LOCK, feeTo: FUND, feeMemo: `blume:fee:${i.transfer.id}`, feeDrops: '1000000' })
    expect(reply.transfer.id).toBe(i.transfer.id)
    // the operators raise the fee afterwards: the transfer a wallet resumes still says what it was quoted
    const raised = { ...i.state, config: { ...i.state.config, params: { ...i.state.config.params, feeXrp: '5' } } }
    expect(toIntentReply(raised, i.transfer).feeDrops).toBe('1000000')
  })
  it('names no fee for an outbound intent, which pays on the EVM side', () => {
    const s = baseState()
    const reply = toIntentReply(s, { id: 'abababababababab', dir: 'out', sym: 'PETAL', amount: '1', receive: '1', step: 1, sigs: 0, sigsNeeded: 2, from: EVM, to: ALICE, done: false, createdAt: NOW, updatedAt: NOW })
    expect(reply.payTo).toBeUndefined()
    expect(reply).not.toHaveProperty('feeTo')
    expect(reply).not.toHaveProperty('feeDrops')
  })
  it('a fee read is a fee read: the drops of what feeOf pays are what the reply asked for', () => {
    const i = intent(baseState())
    const fee = feeOf(i.transfer)
    expect(fee.amount.value).toBe('1')
    expect(fee.memo).toBe(toIntentReply(i.state, i.transfer).feeMemo)
    expect(fee.to).toBe(toIntentReply(i.state, i.transfer).feeTo)
  })
})
