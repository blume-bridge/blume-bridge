import { describe, expect, it } from 'vitest'
import { genesisInfo } from '../scripts/genesis-info'
import dev from '../genesis/dev.json'
import devnet from '../genesis/devnet.json'
import testnet from '../genesis/testnet.json'

describe('genesisInfo: n, k and whether it is mainnet', () => {
  it('reads n and k from a genesis or a bare config', () => {
    expect(genesisInfo({ config: { n: 5, k: 3 } })).toMatchObject({ n: 5, k: 3, network: 'other' })
    expect(genesisInfo({ n: 7, k: 4 })).toMatchObject({ n: 7, k: 4 })
    expect(genesisInfo({ config: { n: 1, k: 1 } })).toMatchObject({ n: 1, k: 1 })
  })

  it('refuses nonsense instead of defaulting to three', () => {
    expect(() => genesisInfo({})).toThrow(/config\.n/)
    expect(() => genesisInfo({ config: { n: 0, k: 0 } })).toThrow(/config\.n/)
    expect(() => genesisInfo({ config: { n: 3.5, k: 2 } })).toThrow(/config\.n/)
    expect(() => genesisInfo({ config: { n: '5', k: 3 } })).toThrow(/config\.n/)
    expect(() => genesisInfo({ config: { n: 3 } })).toThrow(/config\.k/)
    expect(() => genesisInfo({ config: { n: 3, k: 4 } })).toThrow(/config\.k/)
    expect(() => genesisInfo({ config: { n: 3, k: 0 } })).toThrow(/config\.k/)
    expect(() => genesisInfo(null)).toThrow(/config\.n/)
  })

  it('reads as mainnet from the XRPL EVM mainnet chain id', () => {
    const r = genesisInfo({ config: { n: 5, k: 3, evm: { chainId: 1440000 } } })
    expect(r.network).toBe('mainnet')
    expect(r.why).toEqual(['EVM chain id 1440000'])
  })

  it('reads as mainnet from a public mainnet XRPL endpoint, even with no EVM side yet (the first boot)', () => {
    for (const rpc of ['https://xrplcluster.com/', 'https://s1.ripple.com:51234/', 'https://s2.ripple.com:51234/']) {
      const r = genesisInfo({ config: { n: 5, k: 3, xrpl: { rpc: ['https://s.devnet.rippletest.net:51234/', rpc] } } })
      expect(r.network, rpc).toBe('mainnet')
      expect(r.why[0]).toContain('XRPL RPC')
    }
  })

  it('does not call a test network mainnet', () => {
    expect(genesisInfo({ config: { n: 3, k: 2, evm: { chainId: 1449000 }, xrpl: { rpc: ['https://s.devnet.rippletest.net:51234/', 'https://testnet.xrpl-labs.com/', 'not a url'] } } }).network).toBe('other')
  })

  it('knows the checked-in test genesis files are not mainnet', () => {
    for (const g of [dev, devnet, testnet]) {
      const r = genesisInfo(g)
      expect(r.network).toBe('other')
      expect(r.n).toBeGreaterThanOrEqual(r.k)
    }
  })
})
