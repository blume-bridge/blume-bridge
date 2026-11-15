import { describe, expect, it } from 'vitest'
import { buildGenesis, type GenesisInputs } from '../scripts/mainnet-genesis'
import { applyAdmin } from '../src/admin'
import { configProblems, stateFromGenesis } from '../src/state'
import type { Config } from '../src/types'

/**
 * The mainnet genesis as a value. The first boot has no minter (its signers are the nodes' own EVM keys, which do not exist
 * yet), so the EVM side is a plan in the genesis and `admin evm` turns it on; a genesis that names the minter carries it whole.
 */
const ADMIN = 'ed' + 'a'.repeat(64)
const MINTER = '0x36d8339a9d1bff3c37b5e6f5fc345223bf0d18e2'

const inputs = (over: Partial<GenesisInputs> = {}): GenesisInputs => ({
  k: 2,
  n: 3,
  lock: 'rhFRuTtRmKwFzaYpaYSSWjyPL3BXSmA7iL',
  funding: 'rPFTpcpvp5Hxab1opzothQFmUwLQQuKodX',
  admins: [ADMIN],
  xrplRpcs: ['https://xrplcluster.com/'],
  evmRpcs: ['https://rpc.xrplevm.org'],
  rotateXrpl: true,
  rotateEvm: false,
  cursor: 105_000_000,
  evmBlock: 4_200_000,
  seeded: {},
  listXrp: false,
  xrpCap: '200',
  ...over,
})

describe('the first-boot genesis (no minter)', () => {
  // A state keeps the genesis's own config object, so each test builds its own: one that turns the EVM side on must not turn it on for the next.
  const first = () => buildGenesis(inputs())

  it('plans the EVM side and has none yet', () => {
    const g = first()
    expect(g.config).not.toHaveProperty('evm')
    expect(g.config).toHaveProperty('evmPlan')
    expect((g.config as { evmPlan: { chainId: number; rpc: string[]; rotate?: boolean } }).evmPlan).toMatchObject({ chainId: 1440000, rpc: ['https://rpc.xrplevm.org'], rotate: false })
    expect(g.cursor).not.toHaveProperty('evm')
    expect(configProblems(g.config as unknown as Config)).toEqual([])
  })

  it('becomes a working EVM side through the one operator command, and only through it', () => {
    const s = stateFromGenesis(first() as never)
    expect(s.config.evm).toBeUndefined()
    const done = applyAdmin(s, ADMIN, { cmd: 'evm', minter: MINTER, from: '4200123' }, 1)
    expect(done.ok, JSON.stringify(done)).toBe(true)
    expect(s.config.evm).toMatchObject({ chainId: 1440000, rpc: ['https://rpc.xrplevm.org'], rotate: false, windowBlocks: 10, confirmations: 2 })
    expect(s.config.evm!.minter.toLowerCase()).toBe(MINTER)
    expect(s.config.evmPlan).toBeUndefined()
    expect(s.cursor.evm).toEqual({ block: 4200122, seen: [] })
    // what the node writes to config.json and reads back on the next round is still a runnable config
    expect(configProblems(JSON.parse(JSON.stringify(s.config)) as Config)).toEqual([])
  })

  it('does not let anyone but an operator do it', () => {
    const s = stateFromGenesis(first() as never)
    expect(applyAdmin(s, 'ed' + 'b'.repeat(64), { cmd: 'evm', minter: MINTER, from: '4200123' }, 1)).toEqual({ ok: false, error: 'not an operator' })
    expect(s.config.evm).toBeUndefined()
  })
})

describe('a genesis that names the minter', () => {
  const named = () => buildGenesis(inputs({ minter: MINTER }))

  it('carries the EVM side whole, from the block it was built at, and plans nothing', () => {
    const g = named()
    expect(g.config).not.toHaveProperty('evmPlan')
    expect((g.config as { evm: { minter: string; chainId: number } }).evm).toMatchObject({ minter: MINTER, chainId: 1440000 })
    expect(g.cursor).toMatchObject({ evm: { block: 4_200_000, seen: [] } })
    expect(configProblems(g.config as unknown as Config)).toEqual([])
  })

  it('has nothing for the operator command to turn on', () => {
    const s = stateFromGenesis(named() as never)
    expect(applyAdmin(s, ADMIN, { cmd: 'evm', minter: '0x1111111111111111111111111111111111111111', from: '1' }, 1)).toMatchObject({ ok: false, error: expect.stringContaining('already on') })
    expect(s.config.evm!.minter).toBe(MINTER)
  })
})

describe('where the fees go', () => {
  it('has no operator default unless one is given, and carries it into the params when it is', () => {
    expect((buildGenesis(inputs()).config.params.payout as { operatorPayout?: string }).operatorPayout).toBeUndefined()
    const funding = inputs().funding
    const held = buildGenesis(inputs({ operatorPayout: funding }))
    expect((held.config.params.payout as { operatorPayout?: string }).operatorPayout).toBe(funding)
    expect(configProblems(held.config as unknown as Config)).toEqual([])
    const treasury = buildGenesis(inputs({ treasury: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq', operatorPayout: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq' }))
    expect(configProblems(treasury.config as unknown as Config)).toEqual([])
  })
})

describe('what both genesis kinds share', () => {
  it('keeps the rotate switch only when the operator named their own servers', () => {
    expect(buildGenesis(inputs({ rotateXrpl: true, rotateEvm: true })).config.xrpl).not.toHaveProperty('rotate')
    expect(buildGenesis(inputs({ rotateXrpl: false })).config.xrpl).toMatchObject({ rotate: false })
    const on = buildGenesis(inputs({ rotateEvm: true })).config as { evmPlan: object }
    expect(on.evmPlan).not.toHaveProperty('rotate')
  })

  it('lists XRP only on request', () => {
    expect(buildGenesis(inputs()).tokens).not.toHaveProperty('XRP')
    expect(buildGenesis(inputs({ listXrp: true })).tokens).toHaveProperty('XRP')
  })
})
