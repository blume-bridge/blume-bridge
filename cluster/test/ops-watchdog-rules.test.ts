import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  applyDelivered,
  clean,
  configFromEnv,
  emptyState,
  evaluate,
  floorSignificant,
  fromScaled,
  packMessages,
  plan,
  render,
  reviveState,
  suggestCap,
  supplyDue,
  toScaled,
  undeliver,
  type ActionRead,
  type Evaluation,
  type EvmActionRead,
  type Finding,
  type Message,
  type NodeReading,
  type Snapshot,
  type TokenRead,
  type TransferRead,
  type UnmatchedRead,
  type WatchConfig,
  type WatchState,
} from '../scripts/watchdog-rules'

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const MIN = 60_000
const cfg: WatchConfig = { ...DEFAULT_CONFIG }

function node(i: number, over: Partial<NodeReading> = {}, status: Partial<NonNullable<NodeReading['status']>> = {}, at = T0): NodeReading {
  // a healthy node closes a ledger a second
  const lcl = 1000 + Math.round((at - T0) / 1000)
  return {
    index: i,
    label: `node ${i} (front.example:${8442 + i})`,
    ok: true,
    lcl,
    status: { k: 3, n: 5, cursor: 5000, evmCursor: 900, stateHash: 'hash-a', lastRound: { lcl, heard: '4/4', timedOut: false, myView: null, counts: {}, winner: null, evmWinner: null }, ...status },
    ...over,
  }
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  const at = over.at ?? T0
  return {
    at,
    nodes: [1, 2, 3, 4, 5].map((i) => node(i, {}, {}, at)),
    reads: {
      from: 1,
      operators: { k: 3, n: 5, ready: true, lockAccount: 'rLock', fundingAccount: 'rFund', signers: [] },
      tokens: [],
      transfers: [],
      actions: [],
      evmActions: [],
      unmatched: [],
    },
    chains: { xrplHead: 5003, evmHead: 905 },
    accounts: { lock: { account: 'rLock', balanceXrp: 25, reserveXrp: 5, freeXrp: 20 }, funding: { account: 'rFund', balanceXrp: 20, reserveXrp: 1, freeXrp: 19 } },
    relayers: [{ address: '0xaaaa', balanceXrp: 3 }, { address: '0xbbbb', balanceXrp: 2 }],
    pools: {},
    supply: null,
    blind: [],
    ...over,
  }
}
const withReads = (patch: Partial<NonNullable<Snapshot['reads']>>): Partial<Snapshot> => ({ reads: { ...snap().reads!, ...patch } })

interface Run {
  ev: Evaluation
  messages: Message[]
  state: WatchState
}
/** One pass: evaluate, plan, and carry the state forward as the loop does when everything was delivered. */
function pass(s: Snapshot, state: WatchState, config = cfg): Run {
  const ev = evaluate(s, state, config)
  const pl = plan(ev, state.active, config, s.at)
  const next = applyDelivered({ ...ev.state, active: pl.active }, pl.messages)
  return { ev, messages: pl.messages, state: next }
}
/** Passes at the given times, each with a snapshot built from the time. */
function series(times: number[], build: (at: number, i: number) => Snapshot, start: WatchState = emptyState()): Run[] {
  const runs: Run[] = []
  let state = start
  times.forEach((at, i) => {
    const r = pass(build(at, i), state)
    runs.push(r)
    state = r.state
  })
  return runs
}
const keys = (r: Run) => r.ev.findings.map((f) => f.key)
const titles = (r: Run) => r.messages.map((m) => `${m.kind}:${m.title}`)

/** A first pass that baselines tokens, unmatched and failures, so later passes alert only on what is new. */
const baseline = (over: Partial<Snapshot> = {}) => pass(snap(over), emptyState()).state

describe('a healthy cluster', () => {
  it('says nothing, on the first pass and the next', () => {
    const [a, b] = series([T0, T0 + MIN], (at) => snap({ at }))
    expect(a.messages).toEqual([])
    expect(b.messages).toEqual([])
    expect(keys(a)).toEqual([])
  })
})

describe('nodes and ledgers', () => {
  it('a node whose last closed ledger stops advancing is named after the stall window, and recovers', () => {
    const stuck = (at: number) => snap({ at, nodes: [1, 2, 3, 4, 5].map((i) => node(i, { lcl: i === 3 ? 1000 : 1000 + (at - T0) / 1000 })) })
    const runs = series([T0, T0 + MIN, T0 + 3 * MIN], (at) => stuck(at))
    expect(runs[1].messages).toEqual([])
    expect(keys(runs[2])).toEqual(['lcl-stalled:3'])
    expect(titles(runs[2])).toEqual(['alert:node 3 (front.example:8445) has stopped closing ledgers'])
    // it moves again
    const back = pass(snap({ at: T0 + 4 * MIN, nodes: [1, 2, 3, 4, 5].map((i) => node(i, { lcl: 5000 })) }), runs[2].state)
    expect(back.messages.map((m) => m.kind)).toEqual(['recovery'])
  })

  it('consensus at risk is critical when fewer than 80% of the nodes are closing ledgers', () => {
    const stuck = (stalled: number[]) => (at: number) => snap({ at, nodes: [1, 2, 3, 4, 5].map((i) => node(i, { lcl: stalled.includes(i) ? 1000 : 1000 + (at - T0) / 1000 })) })
    const one = series([T0, T0 + 3 * MIN], stuck([2]))
    expect(keys(one[1])).toEqual(['lcl-stalled:2'])
    const two = series([T0, T0 + 3 * MIN], stuck([2, 3]))
    expect(keys(two[1]).sort()).toEqual(['cluster-halting', 'lcl-stalled:2', 'lcl-stalled:3'])
    const halting = two[1].ev.findings.find((f) => f.key === 'cluster-halting')!
    expect(halting.severity).toBe('critical')
    expect(halting.title).toBe('Only 3 of 5 nodes are closing ledgers')
  })

  it('the 80% rule follows n, not a constant', () => {
    const three = (stalled: number[]) => (at: number) =>
      snap({ at, nodes: [1, 2, 3].map((i) => node(i, { lcl: stalled.includes(i) ? 1000 : 1000 + (at - T0) / 1000 }, { n: 3, k: 2 })), ...withReads({ operators: { k: 2, n: 3, ready: true, signers: [] } }) })
    expect(keys(series([T0, T0 + 3 * MIN], three([1]))[1])).toContain('cluster-halting')
    const seven = (stalled: number[]) => (at: number) =>
      snap({ at, nodes: [1, 2, 3, 4, 5, 6, 7].map((i) => node(i, { lcl: stalled.includes(i) ? 1000 : 1000 + (at - T0) / 1000 }, { n: 7, k: 4 })), ...withReads({ operators: { k: 4, n: 7, ready: true, signers: [] } }) })
    expect(keys(series([T0, T0 + 3 * MIN], seven([1]))[1])).not.toContain('cluster-halting')
    expect(keys(series([T0, T0 + 3 * MIN], seven([1, 2]))[1])).toContain('cluster-halting')
  })

  it('one failed pass is a blip, two is a warning, and every node silent is the front door', () => {
    const down = (idx: number[]) => (at: number) => snap({ at, nodes: [1, 2, 3, 4, 5].map((i) => (idx.includes(i) ? node(i, { ok: false, lcl: undefined, status: undefined, error: 'connect timeout' }) : node(i, { lcl: 1000 + (at - T0) / 1000 }))) })
    const some = series([T0, T0 + MIN, T0 + 2 * MIN], down([4]))
    expect(some[0].messages).toEqual([])
    expect(keys(some[1])).toEqual(['node-unreachable:4'])
    expect(some[1].messages).toHaveLength(1)
    expect(some[2].messages).toEqual([])
    const all = series([T0, T0 + MIN], down([1, 2, 3, 4, 5]))
    expect(all[0].messages).toEqual([])
    expect(keys(all[1])).toEqual(['front-door-down'])
    expect(all[1].messages[0].severity).toBe('critical')
  })

  it('does not call things recovered while every node is silent', () => {
    const runs = series([T0, T0 + 3 * MIN, T0 + 4 * MIN, T0 + 5 * MIN], (at, i) =>
      i === 0 ? snap({ at, ...withReads({ transfers: [{ id: 'held-1', held: { result: 'tecNO_LINE', attempts: 1 } }] }) }) : snap({ at, reads: null, nodes: [1, 2, 3, 4, 5].map((n) => node(n, { ok: false, lcl: undefined, status: undefined, error: 'timeout' })) }),
    )
    expect(Object.keys(runs[0].state.active)).toEqual(['transfers-held'])
    for (const r of runs.slice(1)) expect(r.messages.some((m) => m.kind === 'recovery')).toBe(false)
    expect(Object.keys(runs[3].state.active)).toContain('transfers-held')
  })

  it('differing state hashes need to persist before they are critical, then say who holds what', () => {
    const split = (at: number) => snap({ at, nodes: [1, 2, 3, 4, 5].map((i) => node(i, { lcl: 1000 + (at - T0) / 1000 }, { stateHash: i === 5 ? 'hash-b' : 'hash-a' })) })
    const runs = series([T0, T0 + MIN, T0 + 2 * MIN], split)
    expect(runs[0].messages).toEqual([])
    expect(keys(runs[1])).toEqual(['state-hash'])
    const f = runs[1].ev.findings[0]
    expect(f.severity).toBe('critical')
    expect(f.lines.join('\n')).toMatch(/node 1, 2, 3, 4: state hash-a/)
    expect(f.lines.join('\n')).toMatch(/node 5: state hash-b/)
    // a one-off difference that clears is forgotten
    const blip = series([T0, T0 + MIN, T0 + 2 * MIN], (at, i) => snap({ at, nodes: [1, 2, 3, 4, 5].map((n) => node(n, { lcl: 1000 + (at - T0) / 1000 }, { stateHash: i === 0 && n === 5 ? 'hash-b' : 'hash-a' })) }))
    expect(blip.every((r) => r.messages.length === 0)).toBe(true)
  })

  it('contested views are critical after two passes, null views a warning after three', () => {
    const lr = (winner: string | null, myView: string | null, counts: Record<string, number>) => ({ lcl: 1000, heard: '4/4', timedOut: false, myView, counts, winner, evmWinner: null })
    const contested = series([T0, T0 + MIN, T0 + 2 * MIN], (at) => snap({ at, nodes: [1, 2, 3, 4, 5].map((i) => node(i, { lcl: 1000 + (at - T0) / 1000 }, i === 2 ? { lastRound: lr('contested', '10->15 (2)', { a: 3, b: 3 }) } : {})) }))
    expect(contested[0].messages).toEqual([])
    expect(keys(contested[1])).toEqual(['views-contested'])
    expect(contested[1].messages[0].severity).toBe('critical')
    const empty = series([T0, T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN], (at) => snap({ at, nodes: [1, 2, 3, 4, 5].map((i) => node(i, { lcl: 1000 + (at - T0) / 1000 }, i === 4 ? { lastRound: lr(null, '10->15 (2)', { a: 1, b: 1, c: 1 }) } : {})) }))
    expect(empty.slice(0, 2).every((r) => r.messages.length === 0)).toBe(true)
    expect(keys(empty[2])).toEqual(['views-null'])
    // a winner in between resets it
    const flaky = series([T0, T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN], (at, i) => snap({ at, nodes: [1, 2, 3, 4, 5].map((n) => node(n, { lcl: 1000 + (at - T0) / 1000 }, n === 4 ? { lastRound: i === 1 ? lr('abc12345x3 -> ledger 15 (1 events)', '10->15 (1)', { abc: 3 }) : lr(null, '10->15 (2)', { a: 1, b: 1 }) } : {})) }))
    expect(flaky.every((r) => r.messages.length === 0)).toBe(true)
  })
})

describe('cursors against the chains', () => {
  it('warns when the XRPL cursor lags past the window and goes critical at three windows', () => {
    const lag = (n: number) => (at: number) => snap({ at, chains: { xrplHead: 5000 + n, evmHead: 905 } })
    expect(series([T0], lag(100))[0].messages).toEqual([])
    const warn = series([T0], lag(101))[0]
    expect(warn.ev.findings[0]).toMatchObject({ key: 'cursor-lag:xrpl', severity: 'warn' })
    expect(warn.ev.findings[0].title).toBe('The XRP Ledger cursor is 101 ledgers behind')
    expect(series([T0], lag(301))[0].ev.findings[0].severity).toBe('critical')
  })

  it('the EVM cursor has its own window, and only exists when the cluster has an EVM side', () => {
    expect(keys(pass(snap({ chains: { xrplHead: 5003, evmHead: 1200 } }), emptyState()))).toEqual(['cursor-lag:evm'])
    const noEvm = snap({ nodes: [1, 2, 3, 4, 5].map((i) => node(i, {}, { evmCursor: null })), chains: { xrplHead: 5003, evmHead: null } })
    expect(keys(pass(noEvm, emptyState()))).toEqual([])
  })

  it('a head it cannot read is not a lag, and after a few passes it is a warning about itself', () => {
    const blind = (at: number) => snap({ at, chains: { xrplHead: null, evmHead: 905 } })
    const runs = series([T0, T0 + MIN, T0 + 2 * MIN], blind)
    expect(runs[0].messages).toEqual([])
    expect(runs[1].messages).toEqual([])
    expect(keys(runs[2])).toEqual(['rpc-down:xrpl'])
  })

  it('does not call a lag resolved on a pass where the head could not be read', () => {
    const lagging = pass(snap({ chains: { xrplHead: 5500, evmHead: 905 } }), emptyState())
    expect(Object.keys(lagging.state.active)).toEqual(['cursor-lag:xrpl'])
    const blind = pass(snap({ at: T0 + MIN, chains: { xrplHead: null, evmHead: 905 } }), lagging.state)
    expect(blind.messages).toEqual([])
    const fine = pass(snap({ at: T0 + 2 * MIN }), blind.state)
    expect(fine.messages.map((m) => m.kind)).toEqual(['recovery'])
  })

  it('says how long the cursor has been still', () => {
    const runs = series([T0, T0 + 30 * MIN], (at) => snap({ at, chains: { xrplHead: 5500, evmHead: 905 } }))
    expect(runs[1].ev.findings.find((f) => f.key === 'cursor-lag:xrpl')!.lines[0]).toMatch(/has not moved for 30m/)
  })
})

describe('actions', () => {
  const act = (id: string, minutesOld: number, over: Partial<ActionRead> = {}): ActionRead => ({ id, kind: 'xrpl.payment', account: 'lock', status: 'pending', attempts: 1, createdAt: T0 - minutesOld * MIN, updatedAt: T0 - minutesOld * MIN, ...over })

  it('an XRPL action pending for over 30 minutes is a warning, over two hours critical', () => {
    expect(keys(pass(snap(withReads({ actions: [act('a1', 29)] })), emptyState()))).toEqual([])
    const r = pass(snap(withReads({ actions: [act('a1', 31), act('a2', 5), act('a3', 40, { status: 'queued' })] })), emptyState())
    expect(r.ev.findings).toHaveLength(1)
    expect(r.ev.findings[0]).toMatchObject({ key: 'actions-pending', severity: 'warn' })
    expect(r.ev.findings[0].title).toBe('2 XRPL action(s) pending for over 30 minutes')
    expect(pass(snap(withReads({ actions: [act('a1', 125)] })), emptyState()).ev.findings[0].severity).toBe('critical')
    // validated or failed ones are not pending
    expect(keys(pass(snap(withReads({ actions: [act('a1', 90, { status: 'validated' })] })), emptyState()))).toEqual([])
  })

  it('a newly stuck action is announced at once even inside the cooldown', () => {
    const first = pass(snap(withReads({ actions: [act('a1', 31)] })), emptyState())
    const second = pass(snap({ at: T0 + MIN, ...withReads({ actions: [act('a1', 32), act('a2', 31)] }) }), first.state)
    expect(second.messages.map((m) => m.kind)).toEqual(['update'])
  })

  it('an EVM action that has used its relayer attempts (3n) is critical, with n from the cluster', () => {
    const ev = (attempts: number): EvmActionRead => ({ id: 'e1', kind: 'mint', status: 'pending', attempts, createdAt: T0 - 5 * MIN })
    expect(keys(pass(snap(withReads({ evmActions: [ev(14)] })), emptyState()))).toEqual([])
    const r = pass(snap(withReads({ evmActions: [ev(15)] })), emptyState())
    expect(r.ev.findings[0]).toMatchObject({ key: 'evm-actions-stuck', severity: 'critical' })
    // three nodes: the limit is nine
    const three = snap({ ...withReads({ operators: { k: 2, n: 3, ready: true, signers: [] }, evmActions: [ev(9)] }) })
    expect(keys(pass(three, emptyState()))).toEqual(['evm-actions-stuck'])
    expect(keys(pass(snap({ ...withReads({ operators: { k: 2, n: 3, ready: true, signers: [] }, evmActions: [ev(8)] }) }), emptyState()))).toEqual([])
  })

  it('an EVM action pending a long time is a warning of its own', () => {
    const r = pass(snap(withReads({ evmActions: [{ id: 'e2', kind: 'list', status: 'pending', attempts: 2, createdAt: T0 - 45 * MIN }] })), emptyState())
    expect(r.ev.findings[0]).toMatchObject({ key: 'evm-actions-pending', severity: 'warn' })
  })

  it('an action that gave up is announced once, never again, and not for what was already failed before the watchdog started', () => {
    const old: EvmActionRead = { id: 'old', kind: 'mint', status: 'failed', attempts: 15, createdAt: T0 - 600 * MIN }
    const base = pass(snap(withReads({ evmActions: [old] })), emptyState())
    expect(base.messages).toEqual([])
    const fresh: EvmActionRead = { id: 'new', kind: 'mint', status: 'failed', attempts: 15, createdAt: T0 - MIN }
    const a = pass(snap({ at: T0 + MIN, ...withReads({ evmActions: [fresh, old] }) }), base.state)
    expect(a.messages).toHaveLength(1)
    expect(a.messages[0]).toMatchObject({ kind: 'event', severity: 'critical', title: '1 EVM action(s) gave up' })
    const b = pass(snap({ at: T0 + 2 * MIN, ...withReads({ evmActions: [fresh, old] }) }), a.state)
    expect(b.messages).toEqual([])
    // XRPL actions likewise
    const dead: ActionRead = { id: 'x1', kind: 'xrpl.payment', account: 'lock', status: 'failed', attempts: 3, createdAt: T0 }
    const c = pass(snap({ at: T0 + 3 * MIN, ...withReads({ actions: [dead] }) }), b.state)
    expect(c.messages[0]).toMatchObject({ kind: 'event', severity: 'critical' })
  })
})

describe('transfers', () => {
  const held: TransferRead = { id: 'tr-held-1', dir: 'out', sym: 'PETAL', amount: 25, held: { result: 'tecNO_DST', since: T0 - 10 * MIN, until: T0 + 6 * 3_600_000, attempts: 2 } }

  it('a held transfer is a warning that names the result, the attempts and when it will be minted back', () => {
    const r = pass(snap(withReads({ transfers: [held] })), emptyState())
    expect(r.ev.findings[0]).toMatchObject({ key: 'transfers-held', severity: 'warn' })
    expect(r.ev.findings[0].lines[0]).toContain('tecNO_DST')
    expect(r.ev.findings[0].lines[0]).toContain('attempt 2')
    expect(r.ev.findings[0].lines[0]).toContain('2026-10-09T18:00Z')
  })

  it('a second held transfer is announced at once; a repeat only after the cooldown; the end is a recovery', () => {
    const one = pass(snap(withReads({ transfers: [held] })), emptyState())
    const two = pass(snap({ at: T0 + MIN, ...withReads({ transfers: [held, { ...held, id: 'tr-held-2' }] }) }), one.state)
    expect(two.messages.map((m) => m.kind)).toEqual(['update'])
    const quiet = pass(snap({ at: T0 + 30 * MIN, ...withReads({ transfers: [held, { ...held, id: 'tr-held-2' }] }) }), two.state)
    expect(quiet.messages).toEqual([])
    const again = pass(snap({ at: T0 + 62 * MIN, ...withReads({ transfers: [held, { ...held, id: 'tr-held-2' }] }) }), quiet.state)
    expect(again.messages.map((m) => m.kind)).toEqual(['reminder'])
    expect(render(again.messages[0])).toMatch(/STILL FIRING/)
    const done = pass(snap({ at: T0 + 63 * MIN, ...withReads({ transfers: [] }) }), again.state)
    expect(done.messages.map((m) => m.kind)).toEqual(['recovery'])
    expect(render(done.messages[0])).toMatch(/^\[RECOVERED\] 2 transfer\(s\) held/)
  })

  it('a lock waiting for its fee is reported after a short grace, with the amounts', () => {
    const waiting = (ageMin: number): TransferRead => ({ id: 'tr-wait-1', dir: 'in', sym: 'PETAL', amount: 100, from: 'rUserAddressXXXXXXXX', awaitingFee: { feeXrp: '1', feeMemo: 'blume:fee:x', returnMemo: 'return:ab', returnFeeXrp: '0.25' }, createdAt: T0 - ageMin * MIN, updatedAt: T0 - ageMin * MIN })
    expect(keys(pass(snap(withReads({ transfers: [waiting(3)] })), emptyState()))).toEqual([])
    const r = pass(snap(withReads({ transfers: [waiting(8)] })), emptyState())
    expect(r.ev.findings[0].key).toBe('transfers-awaiting-fee')
    expect(r.ev.findings[0].lines.join('\n')).toMatch(/PETAL 100 from rUserAdd\.\., waiting 8m, fee 1 XRP/)
  })

  it('failed transfers are announced once each, expired ones never, and old ones are not announced when the watchdog starts', () => {
    const old: TransferRead = { id: 'old', dir: 'in', sym: 'PETAL', amount: 1, failed: 'cap' }
    const base = pass(snap(withReads({ transfers: [old] })), emptyState())
    expect(base.messages).toEqual([])
    const fresh: TransferRead[] = [{ id: 'f1', dir: 'out', sym: 'PETAL', amount: 3, failed: 'returned' }, { id: 'f2', dir: 'in', sym: 'MOO', amount: 4, failed: 'expired' }, { id: 'f3', dir: 'in', sym: 'PETAL', amount: 5, failed: 'cap' }]
    const a = pass(snap({ at: T0 + MIN, ...withReads({ transfers: [old, ...fresh] }) }), base.state)
    expect(a.messages).toHaveLength(1)
    expect(a.messages[0].kind).toBe('event')
    expect(a.messages[0].severity).toBe('warn')
    expect(a.messages[0].lines.join('\n')).toContain('f1')
    expect(a.messages[0].lines.join('\n')).toContain('f3')
    expect(a.messages[0].lines.join('\n')).not.toContain('f2')
    expect(pass(snap({ at: T0 + 2 * MIN, ...withReads({ transfers: [old, ...fresh] }) }), a.state).messages).toEqual([])
    const unconfirmed = pass(snap({ at: T0 + 3 * MIN, ...withReads({ transfers: [{ id: 'f9', dir: 'in', sym: 'PETAL', amount: 5, failed: 'mint not confirmed' }, ...fresh] }) }), a.state)
    expect(unconfirmed.messages[0].severity).toBe('critical')
  })

  it('ignore list is configurable', () => {
    const base = pass(snap(), emptyState(), { ...cfg, ignoreFailed: ['cap'] })
    const r = pass(snap({ at: T0 + MIN, ...withReads({ transfers: [{ id: 'c', failed: 'cap' }, { id: 'e', failed: 'expired' }] }) }), base.state, { ...cfg, ignoreFailed: ['cap'] })
    expect(r.messages[0].lines.join('\n')).toContain('expired')
    expect(r.messages[0].lines.join('\n')).not.toContain('cap')
  })

  it('a failed read is not a clean bill: a held transfer stays held until a read says otherwise', () => {
    const one = pass(snap(withReads({ transfers: [held] })), emptyState())
    const failedRead = pass(snap({ at: T0 + MIN, ...withReads({ transfers: null }) }), one.state)
    expect(failedRead.messages).toEqual([])
    expect(Object.keys(failedRead.state.active)).toEqual(['transfers-held'])
  })
})

describe('unmatched payments and new tokens', () => {
  const um = (tx: string, over: Partial<UnmatchedRead> = {}): UnmatchedRead => ({ tx, ledger: 99, from: 'rSenderAddressXXXXXXXX', to: 'rLock', amount: { currency: 'XRP', value: '12' }, memo: null, reason: 'unknown-token', ...over })

  it('a payment that arrives unmatched is announced once; the ones already there at the start are not', () => {
    const base = pass(snap(withReads({ unmatched: [um('A'.repeat(64))] })), emptyState())
    expect(base.messages).toEqual([])
    const a = pass(snap({ at: T0 + MIN, ...withReads({ unmatched: [um('A'.repeat(64)), um('B'.repeat(64), { memo: 'return:@everyone `x` **bold**\nsecond line' })] }) }), base.state)
    expect(a.messages).toHaveLength(1)
    const text = render(a.messages[0])
    expect(text).toContain('1 new unmatched payment(s)')
    expect(text).toContain('BBBBBBBBBBBB')
    expect(text).not.toContain('@everyone')
    expect(text).not.toContain('`')
    expect(text).not.toContain('**')
    expect(text).not.toContain('\nsecond line')
    expect(text).toMatch(/a top-up of the lock or funding account shows up here too/)
    const b = pass(snap({ at: T0 + 2 * MIN, ...withReads({ unmatched: [um('A'.repeat(64)), um('B'.repeat(64))] }) }), a.state)
    expect(b.messages).toEqual([])
  })

  const token = (sym: string, over: Partial<TokenRead> = {}): TokenRead => ({ sym, ticker: sym, name: `${sym} Token`, issuer: 'rIssuerAddressXXXXXXXX', currency: sym, status: 'listed', lane: 'issuer', capUnits: '0', lockedUnits: '0', ...over })

  it('a token that newly appears is announced with a suggested cap from its XRP pool', () => {
    const base = pass(snap(withReads({ tokens: [token('PETAL')] })), emptyState())
    expect(base.messages).toEqual([])
    const r = pass(snap({ at: T0 + MIN, ...withReads({ tokens: [token('PETAL'), token('MOO')] }), pools: { MOO: { xrp: '50000', tokens: '2000000' } } }), base.state)
    expect(r.messages).toHaveLength(1)
    const text = render(r.messages[0])
    expect(text).toMatch(/^\[NEW\] New token listed: MOO/)
    expect(text).toContain('suggested cap, if it should have one: 40000 units (1000 XRP worth at the pool price: 50000 XRP / 2000000 tokens)')
    expect(text).toMatch(/set it by hand/)
    expect(pass(snap({ at: T0 + 2 * MIN, ...withReads({ tokens: [token('PETAL'), token('MOO')] }) }), r.state).messages).toEqual([])
  })

  it('says whether the token opens by itself or waits, with the operator command for either, ready to paste', () => {
    const base = pass(snap(withReads({ tokens: [] })), emptyState())
    const text = (t: TokenRead, chainId?: number) => render(pass(snap({ at: T0 + MIN, ...withReads({ tokens: [t], ...(chainId ? { operators: { k: 2, n: 3, ready: true, signers: [], evmChainId: chainId } } : {}) }), pools: { [t.sym]: null } }), base.state).messages[0])
    const waits = text(token('MOO'))
    expect(waits).toContain('waits for an operator: no deposits until it has a cap. To open it: npx tsx scripts/admin.ts cap MOO uncapped --key keys/admin.json --node front.example:8443')
    const opens = text(token('MOO', { autoOpen: true }), 1440000)
    expect(opens).toContain('opens by itself, with no limit, once its ERC-20 lands. To shut it: npx tsx scripts/admin.ts cap MOO 0 --key keys/admin-mainnet.json --node front.example:8443')
    expect(opens).not.toContain('To open it')
  })

  it('says why when there is no usable pool', () => {
    const base = pass(snap(withReads({ tokens: [] })), emptyState())
    const text = (pool: unknown) => render(pass(snap({ at: T0 + MIN, ...withReads({ tokens: [token('MOO')] }), pools: { MOO: pool as never } }), base.state).messages[0])
    expect(text(null)).toContain('no cap suggestion: no XRP pool')
    expect(text({ xrp: '100', tokens: '5000' })).toContain('too thin to price from')
    expect(text(undefined)).toContain('the pool was not read this pass')
  })
})

describe('XRP on the accounts and gas for the relayers', () => {
  const acct = (free: number) => ({ account: 'rLock', balanceXrp: free + 5, reserveXrp: 5, freeXrp: free })
  it('warns under 10 free XRP and is critical under 3', () => {
    expect(keys(pass(snap({ accounts: { lock: acct(10), funding: acct(19) } }), emptyState()))).toEqual([])
    const warn = pass(snap({ accounts: { lock: acct(9.5), funding: acct(19) } }), emptyState())
    expect(warn.ev.findings[0]).toMatchObject({ key: 'xrp-low:lock', severity: 'warn' })
    expect(warn.ev.findings[0].lines[0]).toContain('9.500 XRP free')
    expect(pass(snap({ accounts: { lock: acct(19), funding: acct(2.5) } }), emptyState()).ev.findings[0]).toMatchObject({ key: 'xrp-low:funding', severity: 'critical' })
  })

  it('a low relayer is a warning; all of them low is critical', () => {
    const one = pass(snap({ relayers: [{ address: '0xAAAA', balanceXrp: 0.4 }, { address: '0xbbbb', balanceXrp: 2 }] }), emptyState())
    expect(one.ev.findings[0]).toMatchObject({ key: 'relayer-low:0xaaaa', severity: 'warn' })
    const all = pass(snap({ relayers: [{ address: '0xaaaa', balanceXrp: 0.4 }, { address: '0xbbbb', balanceXrp: 0.2 }] }), emptyState())
    expect(all.ev.findings).toHaveLength(1)
    expect(all.ev.findings[0]).toMatchObject({ key: 'relayers-exhausted', severity: 'critical' })
  })

  it('unreadable balances neither fire nor recover', () => {
    const low = pass(snap({ accounts: { lock: acct(1), funding: acct(19) }, relayers: [{ address: '0xaaaa', balanceXrp: 0.1 }, { address: '0xbbbb', balanceXrp: 2 }] }), emptyState())
    expect(Object.keys(low.state.active).sort()).toEqual(['relayer-low:0xaaaa', 'xrp-low:lock'])
    const blind = pass(snap({ at: T0 + MIN, accounts: null, relayers: null }), low.state)
    expect(blind.messages).toEqual([])
    expect(Object.keys(blind.state.active)).toHaveLength(2)
  })
})

describe('the lock account against the ERC-20 supply', () => {
  const rows = (holding: string, supply: string) => [{ sym: 'PETAL', holding, supply }]
  it('is silent when the lock holds at least the supply, and critical when it holds less', () => {
    expect(keys(pass(snap({ supply: rows('1000.5', '1000.5') }), emptyState()))).toEqual([])
    expect(keys(pass(snap({ supply: rows('1200', '1000') }), emptyState()))).toEqual([])
    const r = pass(snap({ supply: rows('999.5', '1000') }), emptyState())
    expect(r.ev.findings[0]).toMatchObject({ key: 'supply-short:PETAL', severity: 'critical' })
    expect(r.ev.findings[0].lines[0]).toContain('short by 0.5')
  })

  it('allows the relative tolerance IOU arithmetic needs, and no more', () => {
    expect(keys(pass(snap({ supply: rows('999999999.9999999999', '1000000000') }), emptyState()))).toEqual([])
    expect(keys(pass(snap({ supply: rows('999999998', '1000000000') }), emptyState()))).toEqual(['supply-short:PETAL'])
  })

  it('reads small balances written with an exponent', () => {
    expect(toScaled('1e-15')).toBe(1000n)
    expect(toScaled('1.5e3')).toBe(1500n * 10n ** 18n)
    expect(keys(pass(snap({ supply: rows('1.2e-9', '1e-9') }), emptyState()))).toEqual([])
    expect(keys(pass(snap({ supply: rows('0', '1e-9') }), emptyState()))).toEqual(['supply-short:PETAL'])
  })

  it('a row that could not be read is left alone, and the alert is kept until a later check clears it', () => {
    const short = pass(snap({ supply: rows('900', '1000') }), emptyState())
    expect(short.state.lastSupplyCheckAt).toBe(T0)
    const unread = pass(snap({ at: T0 + MIN, supply: [{ sym: 'PETAL', error: 'rpc down' }] }), short.state)
    expect(unread.messages).toEqual([])
    const fixed = pass(snap({ at: T0 + 2 * MIN, supply: rows('1000', '1000') }), unread.state)
    expect(fixed.messages.map((m) => m.kind)).toEqual(['recovery'])
  })

  it('is due once a day, or at once while a shortfall is being tracked', () => {
    const fresh = emptyState()
    expect(supplyDue(fresh, T0, cfg)).toEqual({ due: true, onlyActive: false })
    const done = { ...fresh, lastSupplyCheckAt: T0 }
    expect(supplyDue(done, T0 + 23 * 3_600_000, cfg)).toEqual({ due: false, onlyActive: false })
    expect(supplyDue(done, T0 + 24 * 3_600_000, cfg)).toEqual({ due: true, onlyActive: false })
    const tracking = { ...done, active: { 'supply-short:PETAL': { kind: 'supply-short', severity: 'critical' as const, title: 'x', since: T0, lastSentAt: T0, fingerprint: '' } } }
    expect(supplyDue(tracking, T0 + MIN, cfg)).toEqual({ due: true, onlyActive: true })
  })
})

describe('the watchdog\'s own blind spots', () => {
  it('says so when part of what it watches cannot be read for several passes', () => {
    const runs = series([T0, T0 + MIN, T0 + 2 * MIN], (at) => snap({ at, blind: ['lock account: not found on XRP Ledger'] }))
    expect(runs[1].messages).toEqual([])
    expect(keys(runs[2])).toEqual(['watchdog-blind'])
    const fixed = pass(snap({ at: T0 + 3 * MIN }), runs[2].state)
    expect(fixed.messages.map((m) => m.kind)).toEqual(['recovery'])
  })

  it('says so when a cluster read keeps failing', () => {
    const runs = series([T0, T0 + MIN, T0 + 2 * MIN], (at) => snap({ at, ...withReads({ unmatched: null }) }))
    expect(runs[1].messages).toEqual([])
    expect(keys(runs[2])).toEqual(['reads-failing'])
    expect(runs[2].ev.findings[0].lines[0]).toContain('cannot read: unmatched')
  })
})

describe('planning messages', () => {
  const finding = (over: Partial<Finding> = {}): Finding => ({ key: 'k1', kind: 'kind-a', severity: 'warn', title: 'Something is wrong', lines: ['detail'], ...over })
  const ev = (findings: Finding[], skip: string[] = []): Evaluation => ({ findings, state: emptyState(), skip })

  it('raises, reminds after the cooldown, updates on a change, and recovers', () => {
    const a = plan(ev([finding()]), {}, cfg, T0)
    expect(a.messages.map((m) => m.kind)).toEqual(['alert'])
    const b = plan(ev([finding()]), a.active, cfg, T0 + 59 * MIN)
    expect(b.messages).toEqual([])
    const c = plan(ev([finding()]), b.active, cfg, T0 + 61 * MIN)
    expect(c.messages.map((m) => m.kind)).toEqual(['reminder'])
    expect(c.messages[0].forMs).toBe(61 * MIN)
    const d = plan(ev([finding({ fingerprint: 'x' })]), c.active, cfg, T0 + 62 * MIN)
    expect(d.messages.map((m) => m.kind)).toEqual(['update'])
    const e = plan(ev([finding({ severity: 'critical', fingerprint: 'x' })]), d.active, cfg, T0 + 63 * MIN)
    expect(e.messages.map((m) => `${m.kind}:${m.severity}`)).toEqual(['update:critical'])
    const f = plan(ev([]), e.active, cfg, T0 + 100 * MIN)
    expect(f.messages.map((m) => m.kind)).toEqual(['recovery'])
    expect(f.messages[0].forMs).toBe(100 * MIN)
    expect(f.active).toEqual({})
  })

  it('cooldowns are per kind', () => {
    const quick = { ...cfg, cooldownsByKind: { 'kind-a': 10 } }
    const a = plan(ev([finding()]), {}, quick, T0)
    expect(plan(ev([finding()]), a.active, quick, T0 + 11 * MIN).messages.map((m) => m.kind)).toEqual(['reminder'])
    expect(plan(ev([finding({ kind: 'kind-b', key: 'k2' })]), plan(ev([finding({ kind: 'kind-b', key: 'k2' })]), {}, quick, T0).active, quick, T0 + 11 * MIN).messages).toEqual([])
  })

  it('sends critical before warn before info, and events are never kept', () => {
    const r = plan(ev([finding({ key: 'w', severity: 'warn' }), finding({ key: 'i', severity: 'info', event: true, remember: { list: 'tokens', ids: ['X'] } }), finding({ key: 'c', severity: 'critical' })]), {}, cfg, T0)
    expect(r.messages.map((m) => m.key)).toEqual(['c', 'w', 'i'])
    expect(Object.keys(r.active).sort()).toEqual(['c', 'w'])
  })

  it('a condition under a skipped prefix is not called recovered', () => {
    const active = plan(ev([finding({ key: 'transfers-held' })]), {}, cfg, T0).active
    expect(plan(ev([], ['transfers-']), active, cfg, T0 + MIN).messages).toEqual([])
    expect(plan(ev([], []), active, cfg, T0 + MIN).messages.map((m) => m.kind)).toEqual(['recovery'])
  })

  it('takes an undelivered alert back, so the next pass raises it again; a failed recovery stays active', () => {
    const prev = {}
    const a = plan(ev([finding()]), prev, cfg, T0)
    const lost = undeliver(a.active, prev, a.messages)
    expect(lost).toEqual({})
    expect(plan(ev([finding()]), lost, cfg, T0 + MIN).messages.map((m) => m.kind)).toEqual(['alert'])
    const r = plan(ev([]), a.active, cfg, T0 + 5 * MIN)
    expect(undeliver(r.active, a.active, r.messages)[('k1')]).toEqual(a.active.k1)
  })

  it('an event that was not delivered is not remembered', () => {
    const base = pass(snap(withReads({ tokens: [] })), emptyState())
    const r = pass(snap({ at: T0 + MIN, ...withReads({ tokens: [{ sym: 'NEW', name: 'New' }] }) }), base.state)
    expect(r.messages).toHaveLength(1)
    // not delivered: the state the loop keeps is the evaluation's without applyDelivered
    const kept = { ...r.ev.state, active: r.state.active }
    expect(kept.seen.tokens).not.toContain('NEW')
    expect(pass(snap({ at: T0 + 2 * MIN, ...withReads({ tokens: [{ sym: 'NEW', name: 'New' }] }) }), kept).messages).toHaveLength(1)
    expect(applyDelivered(kept, r.messages).seen.tokens).toContain('NEW')
  })
})

describe('what is sent', () => {
  const m = (over: Partial<Message> = {}): Message => ({ key: 'k', kind: 'alert', severity: 'critical', title: 'Title', lines: ['one', 'two'], ...over })
  it('renders without emoji and with the severity up front', () => {
    expect(render(m())).toBe('[CRITICAL] Title\n  one\n  two')
    expect(render(m({ severity: 'warn', kind: 'reminder', forMs: 2 * 3_600_000 }))).toBe('[WARN] STILL FIRING Title (for 2.0h)\n  one\n  two')
    expect(render(m({ kind: 'recovery', lines: [], forMs: 12 * MIN }))).toBe('[RECOVERED] Title (was firing for 12m)')
    expect(render(m({ kind: 'event', severity: 'info' }))).toMatch(/^\[NEW\] Title/)
    const cp = String.fromCodePoint
    expect(new RegExp(`[${cp(0x1f300)}-${cp(0x1faff)}${cp(0x2600)}-${cp(0x27bf)}]`, 'u').test(render(m()))).toBe(false)
  })

  it('packs messages into posts under the limit without splitting one, and cuts one that is too long on its own', () => {
    const many = Array.from({ length: 10 }, (_, i) => m({ key: `k${i}`, title: `T${i}`, lines: ['x'.repeat(300)] }))
    const posts = packMessages(many, 1000)
    expect(posts.length).toBeGreaterThan(1)
    expect(posts.every((p) => p.text.length <= 1000)).toBe(true)
    expect(posts.flatMap((p) => p.messages.map((x) => x.key))).toEqual(many.map((x) => x.key))
    for (const p of posts) for (const msg of p.messages) expect(p.text).toContain(`T${msg.key.slice(1)}`)
    const huge = packMessages([m({ lines: ['y'.repeat(5000)] })], 1000)
    expect(huge).toHaveLength(1)
    expect(huge[0].text.length).toBeLessThanOrEqual(1000)
    expect(huge[0].text).toContain('(cut)')
    expect(packMessages([], 1000)).toEqual([])
  })

  it('cleans text that came off a chain before it is put in a chat', () => {
    expect(clean('line one\nline two')).toBe('line one line two')
    expect(clean('@everyone **hi** `x` _y_ ~z~ |a| > b \\')).toBe('(at)everyone hi x _y_ z a b')
    expect(clean('tecNO_DST')).toBe('tecNO_DST')
    expect(clean(`zero${String.fromCodePoint(0x200b)}width${String.fromCodePoint(0x202e)}flip\u0000nul`)).toBe('zero width flip nul')
    expect(clean('x'.repeat(100), 20)).toHaveLength(20)
    expect(clean(undefined)).toBe('')
    expect(clean(12.5)).toBe('12.5')
  })
})

describe('configuration', () => {
  it('has the documented defaults', () => {
    const c = configFromEnv({})
    expect(c).toMatchObject({ lclStallSeconds: 120, xrplLagLedgers: 100, evmLagBlocks: 200, actionPendingMinutes: 30, relayerMinXrp: 1, suggestCapXrp: 1000, supplyEveryHours: 24, cooldownMinutes: 60, ignoreFailed: ['expired'] })
  })
  it('takes overrides and validates every one', () => {
    const c = configFromEnv({ WATCHDOG_XRPL_LAG_LEDGERS: '50', WATCHDOG_COOLDOWNS: 'lcl-stalled=15, transfers-held=240', WATCHDOG_IGNORE_FAILED: 'expired,cap', WATCHDOG_SUPPLY_TOLERANCE: '0.000001' })
    expect(c.xrplLagLedgers).toBe(50)
    expect(c.cooldownsByKind).toEqual({ 'lcl-stalled': 15, 'transfers-held': 240 })
    expect(c.ignoreFailed).toEqual(['expired', 'cap'])
    expect(c.supplyTolerance).toBe('0.000001')
    for (const bad of [{ WATCHDOG_XRPL_LAG_LEDGERS: 'lots' }, { WATCHDOG_LCL_STALL_SECONDS: '0' }, { WATCHDOG_COOLDOWNS: 'lcl-stalled' }, { WATCHDOG_COOLDOWNS: 'x=0' }, { WATCHDOG_SUPPLY_TOLERANCE: '1' }, { WATCHDOG_FREE_XRP_CRIT: '20' }]) {
      expect(() => configFromEnv(bad), JSON.stringify(bad)).toThrow(/WATCHDOG_/)
    }
  })
  it('does not share state between calls', () => {
    configFromEnv({ WATCHDOG_COOLDOWNS: 'a=5' })
    expect(configFromEnv({}).cooldownsByKind).toEqual({})
    expect(DEFAULT_CONFIG.cooldownsByKind).toEqual({})
  })
})

describe('decimals and the cap suggestion', () => {
  it('scales and unscales without floats', () => {
    expect(toScaled('1.5')).toBe(1_500_000_000_000_000_000n)
    expect(toScaled('0.000000000000000001')).toBe(1n)
    expect(toScaled('0.0000000000000000019')).toBe(1n)
    expect(toScaled(12)).toBe(12n * 10n ** 18n)
    for (const bad of ['', 'abc', '-1', '1.2.3', '1e999']) expect(toScaled(bad), bad).toBeNull()
    expect(toScaled(undefined)).toBeNull()
    expect(fromScaled(1_500_000_000_000_000_000n)).toBe('1.5')
    expect(fromScaled(5n)).toBe('0.000000000000000005')
    expect(fromScaled(7n * 10n ** 18n)).toBe('7')
    expect(floorSignificant(123456n, 3)).toBe(123000n)
    expect(floorSignificant(99n, 3)).toBe(99n)
  })

  it('prices a cap of N XRP at the pool and rounds it down to three significant digits', () => {
    expect(suggestCap({ xrp: '50000', tokens: '2000000' }, 1000, 1000)).toEqual({ cap: '40000' })
    expect(suggestCap({ xrp: '12345.678', tokens: '98765.4321' }, 1000, 1000)).toEqual({ cap: '8000' })
    expect(suggestCap({ xrp: '1000', tokens: '1' }, 1000, 1000)).toEqual({ cap: '1' })
    expect(suggestCap({ xrp: '5000', tokens: '123456789012' }, 1000, 1000)).toEqual({ cap: '24600000000' })
  })

  it('declines to price from a thin, missing or broken pool', () => {
    expect(suggestCap(null, 1000, 1000)).toMatchObject({ why: expect.stringMatching(/no XRP pool/) })
    expect(suggestCap({ xrp: '999.99', tokens: '5' }, 1000, 1000)).toMatchObject({ why: expect.stringMatching(/too thin/) })
    expect(suggestCap({ xrp: '0', tokens: '5' }, 1000, 1000)).toMatchObject({ why: expect.stringMatching(/could not be read/) })
    expect(suggestCap({ xrp: 'x', tokens: '5' }, 1000, 1000)).toMatchObject({ why: expect.stringMatching(/could not be read/) })
  })
})

describe('state', () => {
  it('revives a good state, and starts fresh from anything else', () => {
    const s = emptyState()
    s.seen.tokens = ['PETAL']
    s.active.x = { kind: 'k', severity: 'warn', title: 't', since: 1, lastSentAt: 2, fingerprint: '' }
    expect(reviveState(JSON.parse(JSON.stringify(s)))).toEqual(s)
    for (const junk of [null, 'x', 5, [], {}, { version: 2 }]) expect(reviveState(junk)).toEqual(emptyState())
    const partial = reviveState({ version: 1, seen: { tokens: ['A'] } })
    expect(partial.seen.tokens).toEqual(['A'])
    expect(partial.seen.unmatched).toEqual([])
    expect(partial.baselined).toEqual({ tokens: false, unmatched: false, failed: false })
  })

  it('does not mutate the state it is given', () => {
    const before = emptyState()
    const frozen = JSON.stringify(before)
    evaluate(snap({ ...withReads({ tokens: [{ sym: 'A' }] }) }), before, cfg)
    expect(JSON.stringify(before)).toBe(frozen)
  })

  it('keeps the seen sets bounded', () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ tx: `T${i}` }))
    const r = pass(snap(withReads({ unmatched: many })), emptyState())
    expect(r.state.seen.unmatched.length).toBe(600)
    expect(r.state.seen.unmatched[599]).toBe('T699')
  })
})
