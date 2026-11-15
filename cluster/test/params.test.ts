import { describe, expect, it } from 'vitest'
import { params, quorum, rpcPolicy, serversFirst, treasuryFrom } from '../scripts/genesis-params'
import { configProblems } from '../src/state'
import type { Config } from '../src/types'
import dev from '../genesis/dev.json'
import devnet from '../genesis/devnet.json'
import testnet from '../genesis/testnet.json'

/**
 * The fee schedule is parameters, and the parameters have one home: the genesis
 * helper. Production and the test ledgers charge the same fees; they differ in
 * their clocks and their caps. Every genesis file in the tree is runnable.
 */

const TREASURY = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const withParams = (p: ReturnType<typeof params>): Config => ({ ...(dev.config as unknown as Config), params: p })
const edit = (fn: (c: Config) => void): string[] => {
  const c = structuredClone(withParams(params('production', { treasuryAccount: TREASURY })))
  fn(c)
  return configProblems(c)
}

describe('the production profile', () => {
  const p = params('production', { treasuryAccount: TREASURY })
  it('charges the schedule in docs/DESIGN.md, all of it in XRP', () => {
    expect(p).toMatchObject({ feeXrp: '1', returnFeeXrp: '0.25', issuerListingFeeXrp: '50', metaFeeXrp: '5', split: { operators: 70, treasury: 30 } })
  })
  it('lets the lock account take a token with a supply of 1e14 (PONGO), because a seed with no cap must not be capped by the ledger', () => {
    expect(Number(p.trustLineLimit)).toBeGreaterThanOrEqual(1e15)
  })
  it('pays out daily, tops the lock account up, and lists new tokens at a cap of 0 until an operator sets one', () => {
    expect(p.payout).toEqual({ everyMs: 86_400_000, minXrp: '5', minShareXrp: '1', lockFloorXrp: '10', treasuryAccount: TREASURY })
    expect(p.defaultCapUnits).toBe('0')
  })
  it('leaves the treasury share in the funding account until a treasury account is named', () => {
    expect(params('production').payout?.treasuryAccount).toBeUndefined()
    expect(configProblems(withParams(params('production')))).toEqual([])
  })
  it('has no token fee, no rounds and no pool-priced cap to configure', () => {
    for (const gone of ['feeRate', 'proposalFeeXrp', 'fundingWindowMs', 'targetXrp', 'capMultiplier', 'targetSplit', 'listingCapXrp']) expect(p).not.toHaveProperty(gone)
    expect(p.split).not.toHaveProperty('contributors')
  })
  it('takes a cap override, which is the one thing the operator may set at genesis', () => {
    expect(params('production', { defaultCapUnits: '1000' }).defaultCapUnits).toBe('1000')
  })
  it('is runnable', () => {
    expect(configProblems(withParams(p))).toEqual([])
  })
})

describe('the test profile', () => {
  const p = params('test')
  it('charges the same fees as production', () => {
    const prod = params('production')
    for (const key of ['feeXrp', 'returnFeeXrp', 'issuerListingFeeXrp', 'metaFeeXrp', 'split', 'xrplFeeDrops', 'trustLineLimit'] as const) expect(p[key]).toEqual(prod[key])
    expect(p.payout?.minShareXrp).toBe(prod.payout?.minShareXrp)
    expect(p.payout?.lockFloorXrp).toBe(prod.payout?.lockFloorXrp)
  })
  it('keeps short clocks and a working cap', () => {
    expect(p).toMatchObject({ defaultCapUnits: '100000', releaseRetryMs: 60000, releaseHoldMs: 300000 })
    expect(p.payout).toMatchObject({ everyMs: 600000, minXrp: '0.5' })
  })
  it('is what every test genesis file carries, so a new option cannot land on one network and go missing on another', () => {
    expect(dev.config.params).toEqual(p)
    expect(devnet.config.params).toEqual(p)
    expect(testnet.config.params).toEqual(p)
  })
})

describe('every genesis file in the tree is runnable', () => {
  it.each([
    ['dev', dev],
    ['devnet', devnet],
    ['testnet', testnet],
  ])('%s', (_name, g) => {
    expect(configProblems(g.config as unknown as Config)).toEqual([])
    // and none of them carries what was deleted
    expect(JSON.stringify(g)).not.toMatch(/feeRate|feeUnits|"rounds"|proposalFeeXrp|listingCapXrp|contributors/)
  })
})

describe('what mainnet-genesis takes from the environment', () => {
  it('requires K and N: the size of the cluster is never assumed', () => {
    expect(() => quorum({})).toThrow('K is required')
    expect(() => quorum({ K: '3' })).toThrow('N is required')
    expect(() => quorum({ N: '5' })).toThrow('K is required')
    expect(() => quorum({ K: '', N: '5' })).toThrow('K is required')
    expect(() => quorum({ K: '3', N: '  ' })).toThrow('N is required')
  })
  it('wants whole numbers', () => {
    for (const bad of ['0', '-3', '2.5', 'three', '03', '1e1', '1000']) expect(() => quorum({ K: bad, N: '5' })).toThrow(/whole number/)
    expect(() => quorum({ K: '3', N: '5x' })).toThrow(/whole number/)
  })
  it('wants 1 <= k <= n and refuses 2k <= n: two groups of k could then disagree', () => {
    expect(quorum({ K: '3', N: '5' })).toEqual({ k: 3, n: 5 })
    expect(quorum({ K: ' 1 ', N: '1' })).toEqual({ k: 1, n: 1 })
    expect(quorum({ K: '2', N: '3' })).toEqual({ k: 2, n: 3 })
    expect(quorum({ K: '5', N: '5' })).toEqual({ k: 5, n: 5 })
    expect(() => quorum({ K: '4', N: '3' })).toThrow('K=4 cannot be more than N=3')
    expect(() => quorum({ K: '2', N: '4' })).toThrow('not a majority')
    expect(() => quorum({ K: '1', N: '2' })).toThrow('not a majority')
    expect(() => quorum({ K: '2', N: '5' })).toThrow('not a majority')
  })
  it('puts the operator\'s own servers first, in front of the public ones, each once', () => {
    const pub = ['https://xrplcluster.com/', 'https://s1.ripple.com:51234/']
    expect(serversFirst('XRPL_RPC', undefined, pub)).toEqual(pub)
    expect(serversFirst('XRPL_RPC', '', pub)).toEqual(pub)
    expect(serversFirst('XRPL_RPC', 'http://127.0.0.1:51234', pub)).toEqual(['http://127.0.0.1:51234', ...pub])
    expect(serversFirst('XRPL_RPC', ' https://a.example/ , https://b.example/ ', pub)).toEqual(['https://a.example/', 'https://b.example/', ...pub])
    // a public server named again keeps the position the operator gave it
    expect(serversFirst('XRPL_RPC', 'https://s1.ripple.com:51234/,https://a.example/', pub)).toEqual(['https://s1.ripple.com:51234/', 'https://a.example/', 'https://xrplcluster.com/'])
    expect(serversFirst('EVM_RPC', 'https://a.example,https://a.example', [])).toEqual(['https://a.example'])
  })
  it('refuses a server that is not a URL, or not http', () => {
    expect(() => serversFirst('XRPL_RPC', 'not-a-url', [])).toThrow('XRPL_RPC: "not-a-url" is not a URL')
    expect(() => serversFirst('EVM_RPC', 'wss://rpc.example/', [])).toThrow('must be http or https')
  })
  it('takes the treasury from TREASURY: optional, an XRPL address, never the lock account', () => {
    expect(treasuryFrom(undefined, 'rLock')).toBeUndefined()
    expect(treasuryFrom('  ', 'rLock')).toBeUndefined()
    expect(treasuryFrom(TREASURY, 'rLock')).toBe(TREASURY)
    expect(() => treasuryFrom('rNotAnAddress', 'rLock')).toThrow('TREASURY must be an XRPL r-address')
    expect(() => treasuryFrom('0x5b7e0c3d1a9f4e2b8d6c7a1e3f5b9d2c4e6a8f1c', 'rLock')).toThrow('TREASURY must be an XRPL r-address')
    expect(() => treasuryFrom(TREASURY, TREASURY)).toThrow('must not be the lock account')
  })
})

describe('a config a node refuses to run', () => {
  it('names the fee that is missing: an old config does not boot on defaults nobody chose', () => {
    const old = structuredClone(withParams(params('production'))) as unknown as { params: Record<string, unknown> }
    delete old.params.returnFeeXrp
    delete old.params.metaFeeXrp
    old.params.proposalFeeXrp = '5'
    old.params.feeRate = { num: 3, den: 1000 }
    old.params.split = { operators: 50, treasury: 20, contributors: 30 }
    expect(configProblems(old as unknown as Config)).toEqual([
      'params.split must be whole percentages of operators and treasury adding up to 100, not {"operators":50,"treasury":20,"contributors":30}',
      'params.returnFeeXrp must be a decimal string, not undefined',
      'params.metaFeeXrp must be a decimal string, not undefined',
    ])
  })
  it('wants every fee above zero: a zero fee is a free path', () => {
    for (const fee of ['feeXrp', 'returnFeeXrp', 'metaFeeXrp', 'issuerListingFeeXrp'] as const) {
      expect(edit((c) => (c.params[fee] = '0'))).toEqual([`params.${fee} must be above zero, not 0`])
      expect(edit((c) => (c.params[fee] = '0.0000000000000000001'))).toHaveLength(1)
      expect(edit((c) => ((c.params as unknown as Record<string, unknown>)[fee] = 1))).toEqual([`params.${fee} must be a decimal string, not 1`])
    }
  })
  it('wants every XRP amount in whole drops: a finer fee would be quoted cut and judged whole', () => {
    for (const fee of ['feeXrp', 'returnFeeXrp', 'metaFeeXrp', 'issuerListingFeeXrp'] as const) {
      expect(edit((c) => (c.params[fee] = '1.0000005'))).toEqual([`params.${fee} must be a whole number of drops (6 decimals at most), not 1.0000005`])
      expect(edit((c) => (c.params[fee] = '1.000001'))).toEqual([])
    }
    expect(edit((c) => (c.params.payout!.minXrp = '0.5000001'))).toEqual(['params.payout.minXrp must be a whole number of drops (6 decimals at most), not 0.5000001'])
    expect(edit((c) => (c.params.payout!.minShareXrp = '1.0000001'))).toHaveLength(1)
    expect(edit((c) => (c.params.payout!.lockFloorXrp = '10.0000001'))).toHaveLength(1)
    // a token amount is not XRP
    expect(edit((c) => (c.params.defaultCapUnits = '100000.123456789'))).toEqual([])
    expect(edit((c) => (c.params.trustLineLimit = '1000000000000.5'))).toEqual([])
  })
  it('wants the split to add up to 100', () => {
    expect(edit((c) => (c.params.split = { operators: 70, treasury: 40 }))).toHaveLength(1)
    expect(edit((c) => (c.params.split = { operators: 100, treasury: 0 }))).toEqual([])
    expect(edit((c) => (c.params.split = { operators: 70.5, treasury: 29.5 }))).toHaveLength(1)
  })
  it('wants k to be a majority of n, and not more than it', () => {
    expect(edit((c) => ((c.k = 3), (c.n = 5)))).toEqual([])
    expect(edit((c) => ((c.k = 2), (c.n = 4)))).toEqual(['k=2 of n=4 is not a majority: two groups of 2 could agree on different views'])
    expect(edit((c) => ((c.k = 3), (c.n = 2)))).toEqual(['k (3) cannot be more than n (2)'])
    expect(edit((c) => ((c.k = 1), (c.n = 1)))).toEqual([])
    expect(edit((c) => (c.k = 0))).toHaveLength(2)
  })
  it('wants the treasury to be an address that is not the lock account', () => {
    expect(edit((c) => (c.params.payout!.treasuryAccount = 'nope'))).toHaveLength(1)
    expect(edit((c) => (c.params.payout!.treasuryAccount = c.xrpl.lockAccount))).toHaveLength(1)
  })
  it('wants a quote the clocks can run on', () => {
    expect(edit((c) => (c.params.xrplFeeDrops = '0'))).toHaveLength(1)
    expect(edit((c) => (c.params.actionTtlLedgers = 0))).toHaveLength(1)
    expect(edit((c) => (c.params.maxOpenIntents = 0))).toHaveLength(1)
    expect(edit((c) => (c.params.defaultCapUnits = '-1'))).toHaveLength(1)
    expect(edit((c) => (c.params.payout!.everyMs = 0))).toHaveLength(1)
  })
})

describe('which servers the mainnet cluster reads from', () => {
  const xrpl = ['https://xrplcluster.com/', 'https://s1.ripple.com:51234/', 'https://s2.ripple.com:51234/']
  const oneEvm = ['https://rpc.xrplevm.org']

  it('will not boot on a single XRPL EVM server without being told to', () => {
    expect(() => rpcPolicy({}, xrpl, oneEvm)).toThrow(/ACCEPT_SINGLE_EVM_RPC=1/)
    expect(() => rpcPolicy({ ACCEPT_SINGLE_EVM_RPC: '0' }, xrpl, oneEvm)).toThrow(/ACCEPT_SINGLE_EVM_RPC=1/)
  })

  it('boots on one when told, and says what that allows', () => {
    const p = rpcPolicy({ ACCEPT_SINGLE_EVM_RPC: '1' }, xrpl, oneEvm)
    expect(p.notes.join(' ')).toMatch(/single server/)
    expect(p.rotateXrpl).toBe(true)
  })

  it('is content with two independent EVM servers, and counts hosts, not URLs', () => {
    expect(rpcPolicy({ EVM_RPC: 'http://10.0.0.5:8545' }, xrpl, ['http://10.0.0.5:8545', ...oneEvm]).rotateEvm).toBe(false)
    expect(() => rpcPolicy({}, xrpl, ['https://rpc.xrplevm.org/a', 'https://rpc.xrplevm.org/b'])).toThrow(/only one XRPL EVM server/)
  })

  it('needs two independent XRP Ledger servers too', () => {
    expect(() => rpcPolicy({ ACCEPT_SINGLE_EVM_RPC: '1' }, ['https://xrplcluster.com/'], oneEvm)).toThrow(/at least two independent servers/)
  })

  it('keeps the operator\'s own servers in order, and rotates only over public ones', () => {
    expect(rpcPolicy({ XRPL_RPC: 'http://10.0.0.4:51234', EVM_RPC: 'http://10.0.0.5:8545', ACCEPT_SINGLE_EVM_RPC: '1' }, ['http://10.0.0.4:51234', ...xrpl], ['http://10.0.0.5:8545', ...oneEvm])).toMatchObject({ rotateXrpl: false, rotateEvm: false })
    expect(rpcPolicy({ ACCEPT_SINGLE_EVM_RPC: '1' }, xrpl, oneEvm)).toMatchObject({ rotateXrpl: true, rotateEvm: true })
  })
})
