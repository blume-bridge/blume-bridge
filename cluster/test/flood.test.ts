import { describe, expect, it } from 'vitest'
import { EVM_VIEW_BYTES, XRPL_VIEW_BYTES, cutWindow, eventBytes } from '../src/feed/window'
import { fakeView } from '../src/feed/fake'
import { applyEvmView, applyView } from '../src/machine'
import { startCollector } from '../src/vote'
import type { EvmEvent, EvmView, LedgerEvent, XrplView } from '../src/types'
import { ALICE, EVM, LOCK, NOW, baseState, evmState, pay, xrp } from './helpers'

/**
 * A flooded ledger or block must be worked through, not stalled on (pre-mainnet review, root cause 3): about 45 payments
 * with 1 KB memos, or 400 one-wei burns in one EVM block, once pushed the round message over the NPL limit and froze the
 * feed for good. Views are bounded by bytes, a position too big for one view is carried a piece at a time, and nothing is
 * dropped or applied twice.
 */

const WIRE_LIMIT = 120_000

describe('a flooded XRP Ledger ledger', () => {
  it('is carried in pieces that each fit, every event once, and the cursor then moves on', () => {
    let s = baseState()
    const from = s.cursor.xrpl.ledger
    // 400 payments to the lock account in one ledger, each with a memo of replacement characters (3 bytes each in UTF-8), then a few more later.
    const memo = '�'.repeat(340)
    const flood: LedgerEvent[] = Array.from({ length: 400 }, () => pay(LOCK, xrp('0.000001'), memo, { ledger: from + 1 }))
    const later: LedgerEvent[] = [pay(LOCK, xrp('0.000001'), null, { ledger: from + 3 }), pay(LOCK, xrp('0.000001'), null, { ledger: from + 3 })]
    const chain = { ledger: from + 100, events: [...flood, ...later] }
    const target = from + s.config.xrpl.windowLedgers

    const views: XrplView[] = []
    let guard = 0
    while (s.cursor.xrpl.ledger < target && guard++ < 500) {
      const v = fakeView(s, chain)
      expect(v).not.toBeNull()
      views.push(v!)
      s = applyView(s, v!, NOW).state
    }
    expect(s.cursor.xrpl.ledger).toBe(target)
    expect(s.cursor.xrpl.skip).toBeUndefined()

    // Several pieces, none over the cap or the byte budget, and the round message holding the biggest still goes out whole.
    expect(views.length).toBeGreaterThan(10)
    for (const v of views) {
      expect(v.events.length).toBeLessThanOrEqual(s.config.xrpl.maxEventsPerView)
      if (v.events.length > 1) expect(v.events.reduce((n, e) => n + eventBytes(e), 0)).toBeLessThanOrEqual(XRPL_VIEW_BYTES)
      expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThan(WIRE_LIMIT)
    }
    // The pieces of the flooded ledger stand at the cursor, with no account snapshots; the last piece of the window moves it.
    const partials = views.filter((v) => v.to === v.from)
    expect(partials.length).toBeGreaterThan(5)
    for (const v of partials) expect(v.accounts).toEqual({})

    // Every event carried exactly once.
    const carried = views.flatMap((v) => v.events.map((e) => (e as { tx: string }).tx))
    expect(new Set(carried).size).toBe(carried.length)
    expect(new Set(carried)).toEqual(new Set([...flood, ...later].map((e) => (e as { tx: string }).tx)))
    // And applied once: the machine saw each of them.
    for (const e of [...flood, ...later]) expect(s.cursor.xrpl.seen).toContain((e as { tx: string }).tx)
  })

  it('a view that does not start where the cursor is, or skips the wrong number of events, is refused', () => {
    const s = baseState()
    const from = s.cursor.xrpl.ledger
    const v: XrplView = { src: 'xrpl', from, to: from, skip: 3, events: [], accounts: {} }
    expect(() => applyView(s, v, NOW)).toThrow(/skips 3/)
    s.cursor.xrpl.skip = 2
    expect(() => applyView(s, { ...v, skip: undefined }, NOW)).toThrow(/skips 0/)
    expect(() => applyView(s, { ...v, from: from - 1, skip: 2 }, NOW)).toThrow(/starts at/)
  })
})

describe('a flooded XRPL EVM block', () => {
  const ADDR = '0x1111111111111111111111111111111111111111'

  it('400 burns in one block are carried in pieces, every one once', () => {
    let s = evmState()
    s.tokens.PETAL.evmAddress = ADDR
    s.tokens.PETAL.lockedUnits = '1000'
    const events: EvmEvent[] = Array.from({ length: 400 }, (_, i) => ({ kind: 'burn', tx: '0xbeef', block: 1005, logIndex: i, token: ADDR, from: EVM, amountWei: '1000000000000000000', rAddress: ALICE, nonce: String(i + 1) }))
    const views: EvmView[] = []
    let guard = 0
    while (s.cursor.evm!.block < 1010 && guard++ < 500) {
      const skip = s.cursor.evm!.skip ?? 0
      const r = cutWindow(events.slice(skip), { from: s.cursor.evm!.block, to: 1010, cap: s.config.evm!.maxEventsPerView, bytes: EVM_VIEW_BYTES, pos: (e) => e.block, size: eventBytes })
      const v: EvmView = { src: 'evm', from: s.cursor.evm!.block, to: r.to, ...(skip > 0 ? { skip } : {}), events: r.events, listings: {} }
      views.push(v)
      s = applyEvmView(s, v, NOW).state
    }
    expect(s.cursor.evm!.block).toBe(1010)
    expect(s.cursor.evm!.skip).toBeUndefined()
    expect(views.length).toBe(8)
    for (const v of views) expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThan(WIRE_LIMIT)
    expect(Object.values(s.transfers).filter((t) => t.dir === 'out')).toHaveLength(400)
  })

  it('refuses an EVM view that skips the wrong number of events', () => {
    const s = evmState()
    expect(() => applyEvmView(s, { src: 'evm', from: 1000, to: 1000, skip: 4, events: [], listings: {} }, NOW)).toThrow(/skips 4/)
  })
})

describe('the round message', () => {
  const fakeCtx = () => {
    const sent: string[] = []
    return {
      sent,
      ctx: {
        publicKey: 'me',
        unl: {
          onMessage: () => undefined,
          send: async (m: string) => {
            if (Buffer.byteLength(m) > 131_072) throw new Error('message too large')
            sent.push(m)
          },
          count: () => 4,
        },
      },
    }
  }
  const bigView = (n: number): XrplView => ({
    src: 'xrpl',
    from: 1,
    to: 2,
    accounts: {},
    events: Array.from({ length: n }, (_, i) => pay(LOCK, xrp('0.000001'), '�'.repeat(300), { ledger: 2 })).map((e, i) => ({ ...e, tx: `T${i}` })),
  })

  it('goes out whole when the views fit', async () => {
    const { ctx, sent } = fakeCtx()
    const c = startCollector(ctx, 1)
    const votes = await c.send({ views: [bigView(20)] })
    expect(votes).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(Buffer.byteLength(sent[0])).toBeLessThanOrEqual(WIRE_LIMIT)
  })

  it('keeps the view that fits when another one is too big, and never throws', async () => {
    const { ctx, sent } = fakeCtx()
    const c = startCollector(ctx, 1)
    const huge = bigView(200) // 200 events of ~1 KB: far over the limit
    const small: EvmView = { src: 'evm', from: 5, to: 6, events: [], listings: {} }
    const votes = await c.send({ views: [huge, small] })
    expect(votes.map((v) => v.src)).toEqual(['evm'])
    expect(sent).toHaveLength(1)
    expect(Buffer.byteLength(sent[0])).toBeLessThanOrEqual(WIRE_LIMIT)
    expect(JSON.parse(sent[0]).views).toHaveLength(1)
  })

  it('counts bytes: a message of replacement characters that is under the limit in characters but over it in bytes is still handled', async () => {
    const { ctx, sent } = fakeCtx()
    const c = startCollector(ctx, 1)
    const v = bigView(120) // 120 x ~1 KB of three-byte characters: about 55 KB of characters, 126 KB of bytes
    expect(JSON.stringify(v).length).toBeLessThan(WIRE_LIMIT)
    expect(Buffer.byteLength(JSON.stringify(v))).toBeGreaterThan(WIRE_LIMIT)
    const votes = await c.send({ views: [v] })
    expect(votes).toEqual([])
    expect(Buffer.byteLength(sent[0])).toBeLessThanOrEqual(WIRE_LIMIT)
  })

  it('survives the transport refusing the message', async () => {
    let calls = 0
    const ctx = { publicKey: 'me', unl: { onMessage: () => undefined, send: async () => void (calls++ === 0 && (() => { throw new Error('too large') })()), count: () => 4 } }
    const c = startCollector(ctx, 1)
    const votes = await c.send({ views: [bigView(2)] })
    expect(votes).toEqual([])
    expect(calls).toBe(2)
  })
})
