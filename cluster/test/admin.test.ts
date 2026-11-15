import { describe, expect, it } from 'vitest'
import { applyAdmin } from '../src/admin'
import { configProblems } from '../src/state'
import { tokenIdOf } from '../src/evm'
import { applyEvmView, applyView, queueEvmWork, validateIntent } from '../src/machine'
import { getAddress } from 'viem'
import type { State } from '../src/types'
import { ALICE, BOB, EVM, FUND, LOCK, MINTER, NOW, accounts, baseState, evmState, feeOf, hashOf64, intent, lockOf, pay, petal, view } from './helpers'

const ADMIN = 'ed' + 'a'.repeat(64)
const STRANGER = 'ed' + 'b'.repeat(64)
const PETAL_ADDR = '0x1111111111111111111111111111111111111111'

/** A cluster with the EVM side up, PETAL on the minter, and one operator key. */
function world(): State {
  const s = evmState()
  s.config.admins = [ADMIN]
  s.tokens.PETAL.evmAddress = PETAL_ADDR
  s.tokens.PETAL.capUnits = '1000'
  s.accounts = Object.fromEntries(Object.entries(accounts()).map(([k, v]) => [k, { ...v, ledger: 100 }]))
  return s
}
const run = (s: State, msg: Record<string, unknown>, by = ADMIN) => applyAdmin(s, by, msg, NOW)

describe('who may send operator commands', () => {
  it('refuses a key the genesis does not list, and leaves no trace of it', () => {
    const s = world()
    expect(run(s, { cmd: 'pause' }, STRANGER)).toEqual({ ok: false, error: 'not an operator' })
    expect(s.paused).toBeUndefined()
    expect(s.adminLog).toBeUndefined()
  })
  it('refuses everyone when no admin is configured', () => {
    const s = world()
    delete s.config.admins
    expect(run(s, { cmd: 'pause' })).toEqual({ ok: false, error: 'not an operator' })
  })
  it('logs what an operator did, and what they tried, newest last and capped', () => {
    const s = world()
    run(s, { cmd: 'pause' })
    run(s, { cmd: 'pause' })
    expect(s.adminLog).toMatchObject([{ cmd: 'pause', ok: true, by: ADMIN.slice(0, 12), at: NOW }, { cmd: 'pause', ok: false }])
    for (let i = 0; i < 300; i++) run(s, { cmd: 'nonsense' })
    expect(s.adminLog).toHaveLength(200)
  })
  it('only takes a well-formed key in the config', () => {
    const s = world()
    expect(configProblems(s.config)).toEqual([])
    s.config.admins = [ADMIN, 'not-a-key']
    expect(configProblems(s.config).join()).toMatch(/admins: "not-a-key" is not a HotPocket user public key/)
  })
  it('refuses a command it does not know', () => {
    expect(run(world(), { cmd: 'mint' })).toMatchObject({ ok: false, error: expect.stringContaining('unknown command') })
  })
})

describe('cap', () => {
  it('sets the cap and asks the minter for it in one signed update', () => {
    const s = world()
    expect(run(s, { cmd: 'cap', sym: 'petal', units: '250.5' })).toEqual({ ok: true, note: 'PETAL cap 250.5' })
    expect(s.tokens.PETAL.capUnits).toBe('250.5')
    const [update] = queueEvmWork(s, NOW).filter((a) => a.kind === 'evm.update')
    expect(update).toBeDefined()
    const action = Object.values(s.evmActions).find((a) => a.kind === 'update')!
    expect(action.data.dailyCap).toBe('250500000000000000000')
    expect(action.data.nonce).toBe('1')
  })
  it('opens a token listed with a cap of 0', () => {
    const s = world()
    s.tokens.PETAL.capUnits = '0'
    expect(validateIntent(s, { dir: 'in', sym: 'PETAL', amount: '1', from: ALICE, to: EVM }).ok).toBe(true)
    run(s, { cmd: 'cap', sym: 'PETAL', units: '5000' })
    expect(s.tokens.PETAL.capUnits).toBe('5000')
  })
  it('"uncapped" removes the cluster cap, and the update asks the minter for no limit', () => {
    const s = world()
    expect(run(s, { cmd: 'cap', sym: 'PETAL', units: 'uncapped' }).ok).toBe(true)
    expect(s.tokens.PETAL.capUnits).toBeUndefined()
    queueEvmWork(s, NOW)
    expect(Object.values(s.evmActions).find((a) => a.kind === 'update')!.data.dailyCap).toBe((2n ** 256n - 1n).toString())
  })
  it('refuses a token with no ERC-20 yet, a bad number, a negative one and one too big to mint', () => {
    const s = world()
    delete s.tokens.PETAL.evmAddress
    expect(run(s, { cmd: 'cap', sym: 'PETAL', units: '5' })).toMatchObject({ ok: false, error: expect.stringContaining('no ERC-20 yet') })
    s.tokens.PETAL.evmAddress = PETAL_ADDR
    expect(run(s, { cmd: 'cap', sym: 'PETAL', units: 'lots' })).toMatchObject({ ok: false, error: expect.stringContaining('decimal') })
    expect(run(s, { cmd: 'cap', sym: 'PETAL', units: '-1' })).toMatchObject({ ok: false, error: 'units cannot be negative' })
    expect(run(s, { cmd: 'cap', sym: 'PETAL', units: '1e41' })).toMatchObject({ ok: false, error: expect.stringContaining('cannot be minted') })
    expect(run(s, { cmd: 'cap', sym: 'NOPE', units: '1' })).toEqual({ ok: false, error: 'unknown token NOPE' })
    expect(s.tokens.PETAL.capUnits).toBe('1000')
    expect(s.tokens.PETAL.metaVersion).toBeUndefined()
  })
})

describe('listings', () => {
  const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
  const MOO = '4D4F4F0000000000000000000000000000000000'
  const issuerFlags = { noFreeze: true, globalFreeze: false, requireAuth: false, clawback: false, defaultRipple: true, disableMaster: false, blackholed: false, transferRate: 1_000_000_000 }
  const listMoo = (s: State) => applyView(s, view(s, [pay(FUND, { currency: 'XRP', value: '50' }, `propose:${JSON.stringify({ c: MOO, i: ISSUER, n: 'Moo' })}`, { from: ISSUER, issuerFlags })]), NOW).state

  it('"open" makes new listings open by themselves, and "wait" puts them back to waiting for a cap', () => {
    const s = world()
    expect(run(s, { cmd: 'listings', mode: 'open' })).toEqual({ ok: true, note: 'new listings open by themselves' })
    expect(s.config.params.listingsOpen).toBe(true)
    expect(listMoo(s).tokens.MOO.autoOpen).toBe(true)
    expect(run(s, { cmd: 'listings', mode: 'WAIT' })).toEqual({ ok: true, note: 'new listings wait for an operator' })
    expect(s.config.params.listingsOpen).toBeUndefined()
    expect(listMoo(s).tokens.MOO.autoOpen).toBeUndefined()
    expect(configProblems(s.config)).toEqual([])
  })
  it('says so when there is nothing to change, refuses any other mode, and is logged either way', () => {
    const s = world()
    expect(run(s, { cmd: 'listings', mode: 'wait' })).toEqual({ ok: false, error: 'new listings already wait for an operator' })
    expect(run(s, { cmd: 'listings', mode: 'yes' })).toMatchObject({ ok: false, error: expect.stringContaining('"open"') })
    expect(run(s, { cmd: 'listings' })).toMatchObject({ ok: false })
    run(s, { cmd: 'listings', mode: 'open' })
    expect(run(s, { cmd: 'listings', mode: 'open' })).toEqual({ ok: false, error: 'new listings already open by themselves' })
    expect(s.adminLog?.map((e) => e.ok)).toEqual([false, false, false, true, false])
  })
  it('leaves the tokens already listed as they are', () => {
    const s = world()
    const before = structuredClone(s.tokens)
    run(s, { cmd: 'listings', mode: 'open' })
    expect(s.tokens).toEqual(before)
  })
  it('is for operators only', () => {
    const s = world()
    expect(run(s, { cmd: 'listings', mode: 'open' }, STRANGER)).toEqual({ ok: false, error: 'not an operator' })
    expect(s.config.params.listingsOpen).toBeUndefined()
  })
  it('takes only true or false in a config', () => {
    const s = world()
    ;(s.config.params as { listingsOpen?: unknown }).listingsOpen = 'yes'
    expect(configProblems(s.config).join()).toMatch(/params.listingsOpen must be true or false/)
  })
})

describe('pause and resume', () => {
  it('pausing the bridge stops new inbound transfers but not outbound ones', () => {
    const s = world()
    expect(run(s, { cmd: 'pause' })).toEqual({ ok: true, note: 'bridge paused' })
    expect(validateIntent(s, { dir: 'in', sym: 'PETAL', amount: '1', from: ALICE, to: EVM })).toEqual({ ok: false, error: 'the bridge is paused: no new transfers until it resumes' })
    expect(validateIntent(s, { dir: 'out', sym: 'PETAL', amount: '1', from: EVM, to: ALICE }).ok).toBe(true)
    expect(run(s, { cmd: 'resume' })).toEqual({ ok: true, note: 'bridge resumed' })
    expect(validateIntent(s, { dir: 'in', sym: 'PETAL', amount: '1', from: ALICE, to: EVM }).ok).toBe(true)
  })
  it('a lock that lands while paused is accounted for, and its mint waits for the resume', () => {
    const s = world()
    const { state: withIntent, transfer } = intent(s, { amount: '10' })
    withIntent.config.admins = [ADMIN]
    run(withIntent, { cmd: 'pause' })
    const { state } = applyView(withIntent, view(withIntent, [feeOf(transfer), lockOf(transfer, petal('10'))]), NOW + 1000)
    expect(state.transfers[transfer.id].step).toBe(3)
    expect(state.tokens.PETAL.lockedUnits).toBe('10')
    expect(queueEvmWork(state, NOW + 2000).filter((a) => a.kind === 'evm.mint')).toEqual([])
    run(state, { cmd: 'resume' })
    expect(queueEvmWork(state, NOW + 3000).filter((a) => a.kind === 'evm.mint')).toHaveLength(1)
  })
  it('pauses one token and leaves the others alone', () => {
    const s = world()
    expect(run(s, { cmd: 'pause', sym: 'PETAL' })).toEqual({ ok: true, note: 'PETAL paused' })
    expect(validateIntent(s, { dir: 'in', sym: 'PETAL', amount: '1', from: ALICE, to: EVM })).toEqual({ ok: false, error: 'PETAL is paused: no new transfers until it resumes' })
    expect(validateIntent(s, { dir: 'in', sym: 'XRP', amount: '1', from: ALICE, to: EVM }).ok).toBe(true)
    expect(run(s, { cmd: 'pause', sym: 'PETAL' }).ok).toBe(false)
    expect(run(s, { cmd: 'resume', sym: 'PETAL' }).ok).toBe(true)
    expect(s.tokens.PETAL.opPaused).toBeUndefined()
  })
  it('refuses to pause what is paused and to resume what runs', () => {
    const s = world()
    expect(run(s, { cmd: 'resume' })).toEqual({ ok: false, error: 'the bridge is already running' })
    run(s, { cmd: 'pause' })
    expect(run(s, { cmd: 'pause' })).toEqual({ ok: false, error: 'the bridge is already paused' })
  })
})

describe('refund', () => {
  it('sends a lock that never paid its fee back to the account that sent it', () => {
    const s = world()
    const { state, transfer } = (() => {
      const i = intent(s, { amount: '10' })
      i.state.config.admins = [ADMIN]
      return { state: i.state, transfer: i.transfer }
    })()
    const locked = applyView(state, view(state, [lockOf(transfer, petal('10'), { tx: hashOf64(77) })]), NOW + 1000).state
    expect(locked.transfers[transfer.id].step).toBe(2)
    const r = run(locked, { cmd: 'refund', tx: hashOf64(77).toLowerCase() })
    expect(r.ok).toBe(true)
    const t = locked.transfers[transfer.id]
    expect(t.failed).toBe('returned')
    const back = locked.actions[t.refundActionId!]
    expect(back.account).toBe('lock')
    expect(back.tx).toMatchObject({ TransactionType: 'Payment', Destination: ALICE })
    // a second refund finds nothing waiting
    expect(run(locked, { cmd: 'refund', tx: hashOf64(77) })).toMatchObject({ ok: false })
  })
  it('sends an unmatched payment back, once, to its sender and to nobody else', () => {
    const s = world()
    const stray = pay(FUND, { currency: 'XRP', value: '25' }, 'who knows', { from: BOB, tx: hashOf64(5) })
    const { state } = applyView(s, view(s, [stray]), NOW + 1000)
    state.config.admins = [ADMIN]
    expect(state.unmatched.some((u) => u.tx === hashOf64(5))).toBe(true)
    const r = run(state, { cmd: 'refund', tx: hashOf64(5), to: ALICE })
    expect(r.ok).toBe(true)
    const entry = state.unmatched.find((u) => u.tx === hashOf64(5))!
    expect(state.actions[entry.returned!].tx).toMatchObject({ Destination: BOB })
    expect(run(state, { cmd: 'refund', tx: hashOf64(5) })).toMatchObject({ ok: false, error: expect.stringContaining('already sent back') })
  })
  it('refuses a hash it does not know and a malformed one', () => {
    const s = world()
    expect(run(s, { cmd: 'refund', tx: hashOf64(404) })).toMatchObject({ ok: false, error: expect.stringContaining('no lock waiting') })
    expect(run(s, { cmd: 'refund', tx: 'abc' })).toMatchObject({ ok: false, error: expect.stringContaining('64-character') })
  })
})

describe('meta', () => {
  it('renames a token and replaces its logo with one update', () => {
    const s = world()
    const logo = 'https://static.xrplmeta.org/icons/PETAL.png'
    expect(run(s, { cmd: 'meta', sym: 'PETAL', name: 'Petal Finance', image: logo }).ok).toBe(true)
    expect(s.tokens.PETAL).toMatchObject({ name: 'Petal Finance', image: logo, metaVersion: 1 })
    queueEvmWork(s, NOW)
    expect(Object.values(s.evmActions).find((a) => a.kind === 'update')!.data).toMatchObject({ name: 'Petal Finance', imageURI: logo })
  })
  it('an empty image removes the logo; a bad one and no change are refused', () => {
    const s = world()
    s.tokens.PETAL.image = 'https://static.xrplmeta.org/icons/OLD.png'
    expect(run(s, { cmd: 'meta', sym: 'PETAL', image: 'http://example.com/x.png' })).toEqual({ ok: false, error: 'image must be an https:// link or an ipfs:// link, as the coin publishes it' })
    expect(run(s, { cmd: 'meta', sym: 'PETAL' })).toEqual({ ok: false, error: 'nothing changes' })
    expect(run(s, { cmd: 'meta', sym: 'PETAL', image: '' }).ok).toBe(true)
    expect(s.tokens.PETAL.image).toBeUndefined()
  })
})

describe('cap ordering', () => {
  it('an emergency cap of 0 is not undone when an earlier update confirms', () => {
    const s = world()
    run(s, { cmd: 'cap', sym: 'PETAL', units: '5000' })
    queueEvmWork(s, NOW) // update nonce 1 asks the minter for 5000
    run(s, { cmd: 'cap', sym: 'PETAL', units: '0' }) // the operator stops mints before that confirms
    expect(s.tokens.PETAL.capUnits).toBe('0')
    const confirmed = applyEvmView(s, { src: 'evm', from: s.cursor.evm!.block, to: s.cursor.evm!.block + 3, listings: {}, events: [{ kind: 'updated', tx: '0xaaa', block: s.cursor.evm!.block + 1, logIndex: 0, tokenId: tokenIdOf(s.tokens.PETAL), token: PETAL_ADDR, dailyCapWei: '5000000000000000000000', nonce: '1' }] }, NOW + 1000).state
    expect(confirmed.tokens.PETAL.capUnits).toBe('0')
    // and the follow-up update carries the 0, not the 5000
    queueEvmWork(confirmed, NOW + 2000)
    const next = Object.values(confirmed.evmActions).filter((a) => a.kind === 'update').find((a) => a.status === 'pending')!
    expect(next.data.nonce).toBe('2')
    expect(next.data.dailyCap).toBe('0')
  })
  it('still adopts the minter\'s cap when nothing newer is pending', () => {
    const s = world()
    run(s, { cmd: 'cap', sym: 'PETAL', units: '5000' })
    queueEvmWork(s, NOW)
    const confirmed = applyEvmView(s, { src: 'evm', from: s.cursor.evm!.block, to: s.cursor.evm!.block + 3, listings: {}, events: [{ kind: 'updated', tx: '0xaaa', block: s.cursor.evm!.block + 1, logIndex: 0, tokenId: tokenIdOf(s.tokens.PETAL), token: PETAL_ADDR, dailyCapWei: '5000000000000000000000', nonce: '1' }] }, NOW + 1000).state
    expect(confirmed.tokens.PETAL.capUnits).toBe('5000')
  })
})

describe('evm', () => {
  const PLAN = { rpc: ['https://rpc.xrplevm.org'], chainId: 1440000, windowBlocks: 10, confirmations: 2, maxEventsPerView: 50, pollMs: 8000, gasLimit: 1500000, relayTimeoutMs: 180000 }
  /** A cluster that booted XRPL-only: its genesis planned the EVM side and is waiting for the minter. */
  function planned(): State {
    const s = baseState()
    delete s.config.evm
    s.config.admins = [ADMIN]
    s.config.evmPlan = structuredClone(PLAN)
    return s
  }

  it('turns the planned EVM side on with the minter, reading from the block it was deployed in', () => {
    const s = planned()
    const r = run(s, { cmd: 'evm', minter: MINTER, from: '4200100' })
    expect(r).toMatchObject({ ok: true, note: expect.stringContaining('reading from block 4200100') })
    // the plan's settings carry over unchanged and the minter is the checksummed address; the plan is consumed
    expect(s.config.evm).toEqual({ ...PLAN, minter: getAddress(MINTER) })
    expect(s.config.evmPlan).toBeUndefined()
    // the cursor names the last block already applied, so the deploy block itself is read
    expect(s.cursor.evm).toEqual({ block: 4200099, seen: [] })
    expect(configProblems(s.config)).toEqual([])
    expect(s.adminLog).toMatchObject([{ cmd: 'evm', ok: true, args: { minter: MINTER, from: '4200100' } }])
  })

  it('works once: a second call is refused, with the minter already named', () => {
    const s = planned()
    expect(run(s, { cmd: 'evm', minter: MINTER, from: '10' }).ok).toBe(true)
    const again = run(s, { cmd: 'evm', minter: '0x1111111111111111111111111111111111111111', from: '10' })
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining('already on') })
    expect(s.config.evm!.minter.toLowerCase()).toBe(MINTER)
  })

  it('does nothing for a cluster whose genesis planned no EVM side, or that has one already', () => {
    const none = planned()
    delete none.config.evmPlan
    expect(run(none, { cmd: 'evm', minter: MINTER, from: '10' })).toMatchObject({ ok: false, error: expect.stringContaining('no evmPlan') })
    expect(none.config.evm).toBeUndefined()
    const on = evmState()
    on.config.admins = [ADMIN]
    const before = on.config.evm!.minter
    expect(run(on, { cmd: 'evm', minter: '0x1111111111111111111111111111111111111111', from: '10' }).ok).toBe(false)
    expect(on.config.evm!.minter).toBe(before)
  })

  it('refuses once anything is locked, because the minter decides which burns release it', () => {
    const s = planned()
    s.tokens.PETAL.lockedUnits = '5'
    expect(run(s, { cmd: 'evm', minter: MINTER, from: '10' })).toMatchObject({ ok: false, error: expect.stringContaining('PETAL already has tokens locked') })
    expect(s.config.evm).toBeUndefined()
    expect(s.config.evmPlan).toBeDefined()
  })

  it('refuses an address that is not one, a mixed-case one with a bad checksum, the zero address and a block that is not a block', () => {
    const s = planned()
    const bad = (extra: Record<string, unknown>) => run(s, { cmd: 'evm', minter: MINTER, from: '10', ...extra })
    expect(bad({ minter: 'not an address' }).ok).toBe(false)
    // the right checksum with the case of its first letter flipped
    const checksummed = getAddress(MINTER)
    const at = checksummed.search(/[a-fA-F]/)
    const flipped = checksummed.slice(0, at) + (checksummed[at] === checksummed[at].toUpperCase() ? checksummed[at].toLowerCase() : checksummed[at].toUpperCase()) + checksummed.slice(at + 1)
    expect(bad({ minter: flipped })).toMatchObject({ ok: false, error: expect.stringContaining('checksum') })
    expect(bad({ minter: MINTER.toUpperCase().replace('0X', '0x') }).ok).toBe(false) // all capitals is a checksum too, and not this one
    expect(bad({ minter: '0x' + '0'.repeat(40) })).toMatchObject({ ok: false, error: expect.stringContaining('zero address') })
    expect(bad({ minter: undefined }).ok).toBe(false)
    for (const from of ['0', '-5', '1.5', 'abc', '', undefined]) expect(bad({ from }), String(from)).toMatchObject({ ok: false, error: expect.stringContaining('block number') })
    expect(s.config.evm).toBeUndefined()
    expect(s.cursor.evm).toBeUndefined()
  })

  it('is for operators only', () => {
    const s = planned()
    expect(run(s, { cmd: 'evm', minter: MINTER, from: '10' }, STRANGER)).toEqual({ ok: false, error: 'not an operator' })
    expect(s.config.evm).toBeUndefined()
  })

  it('starts the EVM work once it is on: the listed tokens are queued for the minter after the first agreed window', () => {
    const s = planned()
    for (const n of ['edAAA', 'edBBB', 'edCCC']) s.operators[n] = { node: n, xrplAddress: 'r' + n, xrplPublicKey: 'ED' + n, evmAddress: '0x' + n.toLowerCase().padEnd(40, '0') }
    expect(queueEvmWork(s, NOW)).toEqual([])
    run(s, { cmd: 'evm', minter: MINTER, from: '10' })
    // nothing is queued before the cursor has been synced by an agreed window, as for a genesis that names the minter
    expect(queueEvmWork(s, NOW)).toEqual([])
    s.cursor.evm!.synced = true
    expect(queueEvmWork(s, NOW).length).toBeGreaterThan(0)
  })
})

describe('the evm plan in a config', () => {
  it('is checked like the EVM side it will become', () => {
    const s = baseState()
    delete s.config.evm
    s.config.evmPlan = { rpc: ['https://rpc.xrplevm.org'], chainId: 1440000, windowBlocks: 10, confirmations: 2, maxEventsPerView: 50, pollMs: 8000, gasLimit: 1500000, relayTimeoutMs: 180000 }
    expect(configProblems(s.config)).toEqual([])
    s.config.evmPlan = { ...s.config.evmPlan, rpc: ['ftp://nope'], chainId: 0, windowBlocks: 0, confirmations: -1 }
    const problems = configProblems(s.config).join('\n')
    expect(problems).toMatch(/evmPlan.rpc must be a list of http\(s\) URLs/)
    expect(problems).toMatch(/evmPlan.chainId/)
    expect(problems).toMatch(/evmPlan.windowBlocks/)
    expect(problems).toMatch(/evmPlan.confirmations/)
  })
  it('cannot sit beside a minter', () => {
    const s = evmState()
    s.config.evmPlan = { rpc: ['https://rpc.xrplevm.org'], chainId: 1440000, windowBlocks: 10, confirmations: 2, maxEventsPerView: 50, pollMs: 8000, gasLimit: 1500000, relayTimeoutMs: 180000 }
    expect(configProblems(s.config).join()).toMatch(/evmPlan is for a cluster that has no minter yet/)
  })
})
