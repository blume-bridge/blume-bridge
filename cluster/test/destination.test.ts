import { classicAddressToXAddress } from 'ripple-address-codec'
import { describe, expect, it } from 'vitest'
import { parseDestination } from '../src/destination'
import { applyEvmView, queueRelease } from '../src/machine'
import type { EvmView, TransferRec } from '../src/types'
import genesis from '../genesis/dev.json'
import { ALICE, EVM, FUND, LOCK, NOW, accounts, evmState } from './helpers'

const x = (tag: number | false, test: boolean) => classicAddressToXAddress(ALICE, tag, test)

describe('parseDestination', () => {
  it('takes a classic address as it is', () => {
    expect(parseDestination(ALICE)).toEqual({ address: ALICE })
  })
  it('decodes an X-address into the account and its destination tag', () => {
    expect(parseDestination(x(4242, false), 'mainnet')).toEqual({ address: ALICE, tag: 4242 })
    expect(parseDestination(x(0, false), 'mainnet')).toEqual({ address: ALICE, tag: 0 })
    expect(parseDestination(x(false, false), 'mainnet')).toEqual({ address: ALICE })
  })
  it('refuses an X-address made for the other network, but only when the network is known', () => {
    expect(parseDestination(x(7, true), 'mainnet')).toBeNull()
    expect(parseDestination(x(7, false), 'test')).toBeNull()
    expect(parseDestination(x(7, true), 'test')).toEqual({ address: ALICE, tag: 7 })
    expect(parseDestination(x(7, true))).toEqual({ address: ALICE, tag: 7 })
  })
  it('refuses anything else', () => {
    for (const bad of ['', 'rNotAnAddress', 'X7AcgcsS1u2sLqD1FgbvvHSQhBjmhPAA4oW1NBsWYTjEbSM', '0x5b7e0c3d1a9f4e2b8d6c7a1e3f5b9d2c4e6a8f1c']) expect(parseDestination(bad)).toBeNull()
  })
})

describe('a burn to an X-address', () => {
  it('releases to the account with the tag, on the network the cluster is on', () => {
    const s = evmState()
    s.config.xrpl.network = 'mainnet'
    s.accounts = Object.fromEntries(Object.entries(accounts()).map(([k, v]) => [k, { ...v, ledger: 100 }]))
    s.tokens.PETAL.evmAddress = '0x1111111111111111111111111111111111111111'
    s.tokens.PETAL.lockedUnits = '100'
    const view: EvmView = {
      src: 'evm',
      from: 1000,
      to: 1010,
      events: [{ kind: 'burn', tx: '0xb', block: 1005, logIndex: 0, token: '0x1111111111111111111111111111111111111111', from: EVM, amountWei: '10000000000000000000', rAddress: x(4242, false), nonce: '1' }],
      listings: {},
    }
    const r = applyEvmView(s, view, NOW).state
    const t = Object.values(r.transfers).find((tr) => tr.dir === 'out')!
    expect(t.to).toBe(ALICE)
    expect(t.destTag).toBe(4242)
    expect(t.held).toBeUndefined()
    const release = r.actions[t.actionId!]
    expect(release.tx).toMatchObject({ TransactionType: 'Payment', Destination: ALICE, DestinationTag: 4242 })
  })

  it('mints back a burn to an X-address of the other network instead of releasing it', () => {
    const s = evmState()
    s.config.xrpl.network = 'mainnet'
    s.tokens.PETAL.evmAddress = '0x1111111111111111111111111111111111111111'
    s.tokens.PETAL.lockedUnits = '100'
    const view: EvmView = {
      src: 'evm',
      from: 1000,
      to: 1010,
      events: [{ kind: 'burn', tx: '0xb', block: 1005, logIndex: 0, token: '0x1111111111111111111111111111111111111111', from: EVM, amountWei: '10000000000000000000', rAddress: x(4242, true), nonce: '1' }],
      listings: {},
    }
    const t = Object.values(applyEvmView(s, view, NOW).state.transfers).find((tr) => tr.dir === 'out')!
    expect(t.held).toMatchObject({ result: 'bad-destination', final: true })
  })

  it('mints back, at once, a burn aimed at an account a release must never pay', () => {
    for (const [why, dest] of [
      ['the lock account', LOCK],
      ['the funding account', FUND],
      ['the zero account', 'rrrrrrrrrrrrrrrrrrrrrhoLvTp'],
      ['account one', 'rrrrrrrrrrrrrrrrrrrrBZbvji'],
      ["the token's own issuer", genesis.tokens.PETAL.issuer],
    ] as const) {
      const s = evmState()
      s.tokens.PETAL.evmAddress = '0x1111111111111111111111111111111111111111'
      s.tokens.PETAL.lockedUnits = '100'
      const view: EvmView = {
        src: 'evm',
        from: 1000,
        to: 1010,
        events: [{ kind: 'burn', tx: '0xb', block: 1005, logIndex: 0, token: '0x1111111111111111111111111111111111111111', from: EVM, amountWei: '10000000000000000000', rAddress: dest, nonce: '1' }],
        listings: {},
      }
      const r = applyEvmView(s, view, NOW)
      const t = Object.values(r.state.transfers).find((tr) => tr.dir === 'out')!
      expect(t.held, why).toMatchObject({ result: 'bad-destination', final: true })
      expect(t.actionId, `${why}: no release is ever queued`).toBeUndefined()
      expect(Object.values(r.state.actions).filter((a) => a.reason.kind === 'release'), why).toHaveLength(0)
    }
  })

  it('a release without a tag carries none', () => {
    const s = evmState()
    s.accounts = Object.fromEntries(Object.entries(accounts()).map(([k, v]) => [k, { ...v, ledger: 100 }]))
    const t: TransferRec = { id: 'o1', dir: 'out', sym: 'PETAL', amount: '5', receive: '5', step: 2, sigs: 0, sigsNeeded: 2, from: EVM, to: ALICE, srcTx: '0xb', done: false, createdAt: NOW, updatedAt: NOW }
    s.transfers.o1 = t
    const a = queueRelease(s, t, NOW)!
    expect(a.tx).not.toHaveProperty('DestinationTag')
  })
})
