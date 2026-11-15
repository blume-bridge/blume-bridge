import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canon } from '../src/canon'
import { loadState, migrateTokens, saveState, stateFromGenesis, tokenProblems } from '../src/state'
import type { Config, TokenRec } from '../src/types'
import genesis from '../genesis/dev.json'

/**
 * A snapshot of the dev cluster taken before the fee plan has to boot on the
 * new code: the old token shape carries over, what can no longer finish goes.
 */
describe('a snapshot from before the fee plan', () => {
  const old = (extra: Record<string, unknown>) => ({ sym: 'OLD', name: 'Old', issuer: 'rIssuer', currency: 'OLD', status: 'listed', lockedUnits: '10', feeUnits: '0.03', ...extra }) as unknown as TokenRec
  const snapshotWith = (rounds: Record<string, unknown>) => ({ config: genesis.config as unknown as Config, cursor: genesis.cursor, tokens: {}, rounds }) as never

  it('carries the surplus over as dustUnits and drops the pool-priced cap', () => {
    const out = migrateTokens({ OLD: old({ listCapUnits: '5000', capUnits: '100' }) })
    expect(out.OLD).toEqual({ sym: 'OLD', name: 'Old', issuer: 'rIssuer', currency: 'OLD', status: 'listed', lockedUnits: '10', dustUnits: '0.03', capUnits: '100' })
  })
  it('drops a token that was still funding or refunded: its round can never finish', () => {
    const out = migrateTokens({ OLD: old({}), GLDN: old({ sym: 'GLDN', status: 'funding' }), GONE: old({ sym: 'GONE', status: 'refunded' }), PAUSED: old({ sym: 'PAUSED', status: 'paused' }) })
    expect(Object.keys(out)).toEqual(['OLD', 'PAUSED'])
  })
  it('leaves a token already in the new shape alone', () => {
    const fresh = { sym: 'NEW', name: 'New', issuer: 'rIssuer', currency: 'NEW', status: 'listed', lockedUnits: '1', dustUnits: '0.5' } as TokenRec
    expect(migrateTokens({ NEW: fresh }).NEW).toEqual(fresh)
    // and one that somehow has both keeps the new one
    expect(migrateTokens({ NEW: { ...fresh, feeUnits: '9' } as unknown as TokenRec }).NEW.dustUnits).toBe('0.5')
  })
  it('boots from a whole snapshot: empty rounds and the old reason kinds are ignored, the rest is kept', () => {
    const snapshot = {
      config: genesis.config as unknown as Config,
      cursor: genesis.cursor,
      tokens: { PETAL: old({ sym: 'PETAL', lockedUnits: '997', feeUnits: '3' }) },
      rounds: { GLDN: { sym: 'GLDN', status: 'funding' } },
      transfers: { t1: { id: 't1', dir: 'in', feeMode: 'token', feeFallback: true } },
      treasuryXrp: '12',
    }
    const state = stateFromGenesis(snapshot as never)
    expect(state.tokens.PETAL).toMatchObject({ lockedUnits: '997', dustUnits: '3' })
    expect('rounds' in state).toBe(false)
    expect(state.treasuryXrp).toBe('12')
    expect(state.transfers.t1).toBeDefined()
    expect(state.fees).toEqual({ xrp: '0', xrpByToken: {}, paidXrp: '0', owed: {}, payouts: [] })
  })
  it('is not started while a funding round still holds contributions: nothing would pay them back', () => {
    expect(() => stateFromGenesis(snapshotWith({ GLDN: { status: 'funding', contributors: { rAlice: '10' } } }))).toThrow(/funding rounds that owe XRP \(GLDN\)/)
    // nor one whose refund or return the ledger has not confirmed
    expect(() => stateFromGenesis(snapshotWith({ B: { status: 'refunded', contributors: { rAlice: '10' }, refunds: [{ to: 'rAlice', xrp: '10', actionId: 'a1' }] } }))).toThrow(/\(B\)/)
    expect(() => stateFromGenesis(snapshotWith({ C: { status: 'listed', returns: [{ tx: 'T', to: 'rAlice', xrp: '1' }] }, A: { status: 'funding', contributors: { rBob: '1' } } }))).toThrow(/\(A, C\)/)
  })
  it('starts once its rounds are settled: listed, or refunded and confirmed', () => {
    const settled = { GLDN: { status: 'listed', contributors: { rAlice: '10' } }, GONE: { status: 'refunded', contributors: { rAlice: '10' }, refunds: [{ to: 'rAlice', xrp: '10', hash: 'H1' }], returns: [{ tx: 'T', to: 'rBob', xrp: '1', hash: 'H2' }] } }
    expect(() => stateFromGenesis(snapshotWith(settled))).not.toThrow()
  })
  it('is refused with the config it carries: the old params are not the new ones', () => {
    const params = { feeRate: { num: 3, den: 1000 }, split: { operators: 50, treasury: 20, contributors: 30 }, proposalFeeXrp: '5', issuerListingFeeXrp: '50', xrplFeeDrops: '1000', actionTtlLedgers: 400, trustLineLimit: '1000000000000', defaultCapUnits: '100000', feeXrp: '1' }
    const config = { ...genesis.config, params } as unknown as Config
    expect(() => stateFromGenesis({ config, cursor: genesis.cursor } as never)).toThrow(/config is not runnable.*params\.split.*params\.returnFeeXrp.*params\.metaFeeXrp/)
  })
})

/** A node's working directory: the state files sit in the cwd, as HotPocket runs the contract. */
describe('a node\'s own files', () => {
  const cwd = process.cwd()
  let dir: string | undefined
  const enter = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-state-'))
    process.chdir(dir)
    return dir
  }
  afterEach(() => {
    process.chdir(cwd)
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('read back exactly as they were written', () => {
    enter()
    const written = stateFromGenesis({ config: genesis.config as unknown as Config, cursor: genesis.cursor, tokens: genesis.tokens as never })
    expect(saveState(written).sort()).toEqual(['accounts.json', 'actions.json', 'admin.json', 'config.json', 'cursor.json', 'evm-actions.json', 'fees.json', 'operators.json', 'tokens.json', 'transfers.json', 'treasury.json', 'unmatched.json'])
    const { state, fresh } = loadState()
    expect(fresh).toBe(false)
    expect(canon(state)).toBe(canon(written))
    // nothing changed, so nothing is written again
    expect(saveState(state)).toEqual([])
  })
  it('are refused when the config in them is one an older code wrote, whatever else they hold', () => {
    enter()
    fs.writeFileSync('config.json', JSON.stringify({ ...genesis.config, params: { ...genesis.config.params, split: { operators: 50, treasury: 20, contributors: 30 } } }))
    fs.writeFileSync('tokens.json', JSON.stringify({ OLD: { sym: 'OLD', status: 'listed', lockedUnits: '1', feeUnits: '0.1' } }))
    expect(() => loadState()).toThrow(/config is not runnable.*params\.split/)
  })
})

describe('the trust line limit a genesis token carries', () => {
  const seed = (trustLimit?: unknown) => ({ SEED: { sym: 'SEED', name: 'Seed', issuer: 'rIssuer', currency: 'SED', status: 'listed', lane: 'genesis', lockedUnits: '0', dustUnits: '0', ...(trustLimit === undefined ? {} : { trustLimit }) } as unknown as TokenRec })
  const boot = (tokens: Record<string, TokenRec>) => stateFromGenesis({ config: genesis.config as unknown as Config, cursor: genesis.cursor, tokens } as never)

  it('is an amount the XRP Ledger takes: a plain decimal above zero with at most 16 significant digits', () => {
    for (const ok of ['1', '2335', '99980000000000', '1234.5678', '0.5', '9998000000000000000']) expect(tokenProblems(seed(ok)), ok).toEqual([])
    expect(tokenProblems(seed())).toEqual([]) // none: the default applies
  })
  it('refuses anything else, so a bad limit stops the boot instead of failing the TrustSet later', () => {
    for (const bad of ['0', '0.000', '-5', '1e15', '12,000', 'lots', '', 12345, null, '1234567890123456789.5']) expect(tokenProblems(seed(bad)).length, String(bad)).toBeGreaterThan(0)
    expect(() => boot(seed('1e15'))).toThrow(/genesis tokens are not runnable: SEED: trustLimit/)
    expect(() => boot(seed('99980000000000'))).not.toThrow()
  })
})
