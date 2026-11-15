import { describe, expect, it } from 'vitest'
import { cutWindow, eventBytes } from '../src/feed/window'
import { fakeView } from '../src/feed/fake'
import { applyView } from '../src/machine'
import type { LedgerEvent, State, XrplPaymentEvent } from '../src/types'
import genesis from '../genesis/dev.json'

const ALICE = 'rJfqVsXN3i6AD9ErSdNo98cyoKw6Euxj8K'
const LOCK = genesis.config.xrpl.lockAccount
const NOW = 1788912000000

function base(): State {
  return { config: genesis.config as State['config'], tokens: structuredClone(genesis.tokens) as State['tokens'], transfers: {}, operators: {}, actions: {}, evmActions: {}, accounts: {}, cursor: structuredClone(genesis.cursor), unmatched: [], treasuryXrp: '0', fees: { xrp: '0', xrpByToken: {}, paidXrp: '0', owed: {}, payouts: [] } }
}
let seq = 0
function pay(ledger: number): XrplPaymentEvent {
  seq++
  return { kind: 'payment', tx: `TX${String(seq).padStart(5, '0')}`, ledger, from: ALICE, to: LOCK, amount: { currency: 'XRP', value: '0.000001' }, memo: null }
}
/** `perLedger[i]` events in ledger from+1+i. */
function spread(from: number, perLedger: number[]): XrplPaymentEvent[] {
  const out: XrplPaymentEvent[] = []
  perLedger.forEach((n, i) => {
    for (let j = 0; j < n; j++) out.push(pay(from + 1 + i))
  })
  return out.sort((a, b) => a.ledger - b.ledger || a.tx.localeCompare(b.tx))
}
const at = (e: { ledger: number }) => e.ledger

const bounds = (from: number, to: number, cap = 50, bytes = 1_000_000) => ({ from, to, cap, bytes, pos: at, size: eventBytes })

describe('cutWindow', () => {
  it('leaves a window that fits alone', () => {
    const events = spread(100, [10, 10, 10, 10, 10])
    const r = cutWindow(events, bounds(100, 105))
    expect(r).toEqual({ to: 105, events, cut: false, partial: false })
  })
  it('ends the window on the last whole ledger under the cap', () => {
    const events = spread(100, [20, 20, 20, 20, 20])
    const r = cutWindow(events, bounds(100, 105))
    expect(r.cut).toBe(true)
    expect(r.partial).toBe(false)
    expect(r.to).toBe(102)
    expect(r.events).toEqual(events.slice(0, 40))
  })
  it('skips the empty ledgers before the one that overflows', () => {
    const events = spread(100, [0, 0, 30, 30, 0])
    const r = cutWindow(events, bounds(100, 105))
    expect(r.to).toBe(103)
    expect(r.events).toHaveLength(30)
  })
  it('carries only a prefix of a single ledger over the cap, and leaves the cursor where it is', () => {
    const events = spread(100, [70, 5, 5, 5, 5])
    const r = cutWindow(events, bounds(100, 105))
    expect(r.partial).toBe(true)
    expect(r.to).toBe(100)
    expect(r.events).toEqual(events.slice(0, 50))
  })
  it('bounds a view by bytes as well as by count', () => {
    const events = spread(100, [10, 10, 10, 10, 10])
    const one = eventBytes(events[0])
    const r = cutWindow(events, bounds(100, 105, 50, one * 25))
    expect(r.cut).toBe(true)
    expect(r.to).toBe(102)
    expect(r.events).toHaveLength(20)
  })
  it('still carries one event when a single event is bigger than the byte budget', () => {
    const events = spread(100, [3, 3])
    const r = cutWindow(events, bounds(100, 105, 50, 10))
    expect(r.partial).toBe(true)
    expect(r.events).toHaveLength(1)
  })
  it('counts bytes, not characters: a replacement character in a memo is three bytes', () => {
    const e = { ...pay(101), memo: '\uFFFD'.repeat(100) }
    expect(eventBytes(e)).toBeGreaterThan(JSON.stringify(e).length + 150)
  })
  it('never drops or duplicates an event, however a flood is cut, and every view stays inside its bounds', () => {
    for (let trial = 0; trial < 200; trial++) {
      let x = 12345 + trial
      const rnd = (n: number) => ((x = (x * 1103515245 + 12345) & 0x7fffffff) % n)
      const cap = 1 + rnd(60)
      const budget = rnd(2) ? 1_000_000 : eventBytes(pay(1)) * (1 + rnd(40))
      const all: XrplPaymentEvent[] = []
      const ledgers = 1 + rnd(12)
      for (let l = 1; l <= ledgers; l++) for (let j = rnd(2) ? rnd(150) : 0; j > 0; j--) all.push(pay(1000 + l))
      all.sort((a, b) => a.ledger - b.ledger || a.tx.localeCompare(b.tx))
      const seen: string[] = []
      let cursor = 1000
      let skip = 0
      const end = 1000 + ledgers
      let guard = 0
      while (cursor < end && guard++ < 5000) {
        const to = Math.min(end, cursor + 5)
        const win = all.filter((e) => e.ledger > cursor && e.ledger <= to).slice(skip)
        const r = cutWindow(win, bounds(cursor, to, cap, budget))
        expect(r.events.length).toBeLessThanOrEqual(Math.max(1, cap))
        if (r.events.length > 1) expect(r.events.reduce((n, e) => n + eventBytes(e), 0)).toBeLessThanOrEqual(budget)
        expect(r.to).toBeGreaterThanOrEqual(cursor)
        expect(r.to).toBeLessThanOrEqual(to)
        seen.push(...r.events.map((e) => e.tx))
        if (r.partial) {
          expect(r.to).toBe(cursor)
          // every event of a partial view belongs to the one ledger the cursor is about to enter
          expect(new Set(r.events.map(at)).size).toBe(1)
          skip += r.events.length
        } else {
          // Whole ledgers only: everything in (cursor, r.to] after the skip is in the view, nothing after it is.
          expect(r.events).toEqual(all.filter((e) => e.ledger > cursor && e.ledger <= r.to).slice(skip))
          cursor = r.to
          skip = 0
        }
      }
      expect(cursor).toBe(end)
      expect(seen).toEqual(all.map((e) => e.tx))
    }
  })
})

describe('fakeView', () => {
  it('walks a busy pretend ledger window by window without losing an event', () => {
    const s = base()
    const from = s.cursor.xrpl.ledger
    const events: LedgerEvent[] = spread(from, [30, 30, 30, 5, 5, 1, 1, 1, 1, 1])
    const chain = { ledger: from + 20, events } // the chain runs ahead: a window only closes once the ledger passes its full end
    const seen: string[] = []
    let guard = 0
    while (s.cursor.xrpl.ledger < from + 10 && guard++ < 20) {
      const v = fakeView(s, chain)
      expect(v).not.toBeNull()
      if (!v) return
      expect(v.events.length).toBeLessThanOrEqual(s.config.xrpl.maxEventsPerView)
      seen.push(...v.events.map((e) => e.tx))
      s.cursor.xrpl.ledger = v.to
    }
    expect(s.cursor.xrpl.ledger).toBeGreaterThanOrEqual(from + 10)
    expect(seen).toEqual(events.map((e) => e.tx))
  })
  it('proposes nothing until the pretend ledger closes the full window', () => {
    const s = base()
    expect(fakeView(s, { ledger: s.cursor.xrpl.ledger + 4, events: [] })).toBeNull()
    expect(fakeView(s, { ledger: s.cursor.xrpl.ledger + 5, events: [] })?.to).toBe(s.cursor.xrpl.ledger + 5)
  })
})

describe('applyView with a short window', () => {
  it('moves the cursor to the view end, not to the configured window end', () => {
    const s = base()
    const from = s.cursor.xrpl.ledger
    const accounts = { [LOCK]: { sequence: 10, balanceDrops: '100000000' }, [genesis.config.xrpl.fundingAccount]: { sequence: 20, balanceDrops: '125000000' } }
    const { state } = applyView(s, { src: 'xrpl', from, to: from + 2, events: [], accounts }, NOW)
    expect(state.cursor.xrpl.ledger).toBe(from + 2)
  })
})

describe('aheadWindows', () => {
  it('names the next windows the chain has already validated, and none at the head', async () => {
    const { aheadWindows } = await import('../src/feed/xrpl')
    expect(aheadWindows(100, 100, 5)).toEqual([])
    expect(aheadWindows(100, 104, 5)).toEqual([])
    expect(aheadWindows(100, 105, 5)).toEqual([105])
    expect(aheadWindows(100, 109, 5)).toEqual([105])
    expect(aheadWindows(100, 110, 5)).toEqual([105, 110])
    expect(aheadWindows(100, 5000, 5)).toEqual([105, 110])
    expect(aheadWindows(100, 5000, 5, 3)).toEqual([105, 110, 115])
  })
})
