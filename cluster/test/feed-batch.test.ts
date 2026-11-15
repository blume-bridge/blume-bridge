import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountEvents, parseAccountTxEntry } from '../src/feed/xrpl'
import type { XrplConfig } from '../src/types'
import fixture from './fixtures/devnet-batch-account-tx.json'

/**
 * The feed talks to the ledger over node:https, so a captured response is
 * served from there and accountEvents runs whole, paging and all. Set
 * `stub.answer` to the response the server should give.
 */
const stub = vi.hoisted(() => ({ answer: null as null | ((params: Record<string, any>) => unknown), asked: [] as Record<string, any>[] }))

vi.mock('node:https', async () => {
  const { PassThrough } = await import('node:stream')
  return {
    default: {
      request(_opts: unknown, onRes: (res: unknown) => void) {
        // postJson rejects on 'error', so a stub that throws fails the test instead of leaving the promise pending forever.
        const handlers: Record<string, (e: Error) => void> = {}
        return {
          on: (event: string, fn: (e: Error) => void) => {
            handlers[event] = fn
          },
          destroy: () => {},
          end(body: string) {
            const params = JSON.parse(body).params[0] as Record<string, any>
            stub.asked.push(params)
            setImmediate(() => {
              let payload: string
              try {
                payload = JSON.stringify({ result: stub.answer?.(params) ?? { error: 'no stubbed answer' } })
              } catch (e) {
                handlers.error?.(e as Error)
                return
              }
              const res = Object.assign(new PassThrough(), { statusCode: 200 })
              onRes(res)
              res.end(payload)
            })
          },
        }
      },
    },
  }
})

/**
 * Raw account_tx responses captured on XRPL Devnet by scripts/devnet-batch-check.ts:
 * A sent one tfAllOrNothing Batch whose two inner Payments paid B (memo
 * blume:test:lock) and C (memo blume:fee:test), 1 XRP each. The feed must read
 * the inners as ordinary payments that remember the outer, and the outer as an
 * outgoing Batch that counts them.
 */
const { A, B, C } = fixture.accounts
const OUTER = fixture.batch
const LEDGER = fixture.ledger
const entries = (who: 'A' | 'B' | 'C') => fixture.accountTx[who].transactions
const byType = (type: string) => entries('A').filter((e) => e.tx_json.TransactionType === type)
const outerEntry = byType('Batch')[0]
const [lockEntry, feeEntry] = byType('Payment')
const outerSeq = outerEntry.tx_json.Sequence

describe('parseAccountTxEntry with a Batch on the ledger', () => {
  it('reads an inner payment to the lock account as a payment that remembers the outer', () => {
    const parsed = parseAccountTxEntry(entries('B')[0], B)
    expect(parsed?.ledger).toBe(LEDGER)
    expect(parsed?.event).toEqual({
      kind: 'payment',
      tx: lockEntry.hash,
      ledger: LEDGER,
      from: A,
      to: B,
      amount: { currency: 'XRP', value: '1' },
      memo: 'blume:test:lock',
      batch: OUTER,
    })
  })

  it('reads an inner payment to the funding account the same way', () => {
    const parsed = parseAccountTxEntry(entries('C')[0], C)
    expect(parsed?.event).toEqual({
      kind: 'payment',
      tx: feeEntry.hash,
      ledger: LEDGER,
      from: A,
      to: C,
      amount: { currency: 'XRP', value: '1' },
      memo: 'blume:fee:test',
      batch: OUTER,
    })
  })

  it('reads the outer Batch from the sender as an outgoing event with an inner count and nothing else', () => {
    const parsed = parseAccountTxEntry(outerEntry, A)
    expect(parsed?.ledger).toBe(LEDGER)
    expect(parsed?.event).toEqual({
      kind: 'outgoing',
      tx: OUTER,
      ledger: LEDGER,
      account: A,
      type: 'Batch',
      result: 'tesSUCCESS',
      sequence: outerSeq,
      inner: 2,
    })
    expect(parsed?.event).not.toHaveProperty('destination')
    expect(parsed?.event).not.toHaveProperty('amount')
    expect(parsed?.event).not.toHaveProperty('batch')
  })

  it('reads the inner payments from the sender as outgoing Payments at the next sequences, each remembering the outer', () => {
    expect(parseAccountTxEntry(lockEntry, A)?.event).toEqual({
      kind: 'outgoing',
      tx: lockEntry.hash,
      ledger: LEDGER,
      account: A,
      type: 'Payment',
      result: 'tesSUCCESS',
      sequence: outerSeq + 1,
      destination: B,
      amount: { currency: 'XRP', value: '1' },
      batch: OUTER,
    })
    expect(parseAccountTxEntry(feeEntry, A)?.event).toEqual({
      kind: 'outgoing',
      tx: feeEntry.hash,
      ledger: LEDGER,
      account: A,
      type: 'Payment',
      result: 'tesSUCCESS',
      sequence: outerSeq + 2,
      destination: C,
      amount: { currency: 'XRP', value: '1' },
      batch: OUTER,
    })
    expect(parseAccountTxEntry(lockEntry, A)?.event).not.toHaveProperty('inner')
  })

  it('spells the outer hash upper-case however the server did', () => {
    const entry = structuredClone(entries('B')[0])
    entry.meta.ParentBatchID = OUTER.toLowerCase()
    expect(parseAccountTxEntry(entry, B)?.event).toMatchObject({ batch: OUTER })
  })

  it('leaves batch off a payment that was not inside one', () => {
    const entry = structuredClone(entries('B')[0])
    delete (entry.meta as Partial<typeof entry.meta>).ParentBatchID
    const event = parseAccountTxEntry(entry, B)?.event
    expect(event).toMatchObject({ kind: 'payment', tx: lockEntry.hash, memo: 'blume:test:lock' })
    expect(event).not.toHaveProperty('batch')
  })

  it('yields the ledger but no event for an inner payment that neither came from nor reached the account', () => {
    expect(parseAccountTxEntry(entries('B')[0], C)).toEqual({ ledger: LEDGER, event: null })
  })

  it('skips an entry the server has not validated or cannot describe', () => {
    expect(parseAccountTxEntry({ ...entries('B')[0], validated: false }, B)).toBeNull()
    expect(parseAccountTxEntry({ ...entries('B')[0], meta: undefined }, B)).toBeNull()
    expect(parseAccountTxEntry(undefined, B)).toBeNull()
  })

  /**
   * tfAllOrNothing discards every inner when one fails, so nothing is recorded
   * and the captured fixture cannot hold a failed inner. tfIndependent records
   * each with its own result, and the entry is this one but for the result and
   * the delivery — which is what the reducer settles a batch action by.
   */
  it('still reports an inner our own account sent when it failed, so the reducer sees the tec', () => {
    const entry = structuredClone(lockEntry)
    entry.meta.TransactionResult = 'tecUNFUNDED_PAYMENT'
    delete (entry.meta as Partial<typeof entry.meta>).delivered_amount
    expect(parseAccountTxEntry(entry, A)?.event).toEqual({
      kind: 'outgoing',
      tx: lockEntry.hash,
      ledger: LEDGER,
      account: A,
      type: 'Payment',
      result: 'tecUNFUNDED_PAYMENT',
      sequence: outerSeq + 1,
      destination: B,
      // What it asked to send, not what arrived: the reducer matches the event to the action it queued.
      amount: { currency: 'XRP', value: '1' },
      batch: OUTER,
    })
  })

  it('drops a failed inner payment in, because nothing reached the account', () => {
    const entry = structuredClone(entries('B')[0])
    entry.meta.TransactionResult = 'tecUNFUNDED_PAYMENT'
    expect(parseAccountTxEntry(entry, B)).toEqual({ ledger: LEDGER, event: null })
  })

  /** A throw here would escape the whole window read and wedge the cursor at this ledger on every node, so an amount dec refuses has to come back as no event. */
  it('drops a payment whose delivered amount is one it cannot represent, without throwing', () => {
    for (const delivered of ['unavailable', { mpt_issuance_id: '00000000', value: '1' }]) {
      const entry = structuredClone(entries('B')[0])
      entry.meta.delivered_amount = delivered as typeof entry.meta.delivered_amount
      expect(parseAccountTxEntry(entry, B)).toEqual({ ledger: LEDGER, event: null })
    }
  })
})

describe('accountEvents over the captured Devnet responses', () => {
  const cfg: XrplConfig = { rpc: ['https://s.devnet.rippletest.net:51234/'], lockAccount: B, fundingAccount: C, windowLedgers: 5, maxEventsPerView: 50, pollMs: 8000 }
  const serveFixture = () => {
    stub.answer = (p) => fixture.accountTx[p.account === A ? 'A' : p.account === B ? 'B' : 'C']
  }

  afterEach(() => {
    stub.answer = null
    stub.asked.length = 0
  })

  it('asks for the window it was given and reports the inner payment to the lock account', async () => {
    serveFixture()
    const read = await accountEvents(cfg, B, LEDGER, LEDGER, 5000)
    expect(stub.asked).toEqual([{ api_version: 2, account: B, ledger_index_min: LEDGER, ledger_index_max: LEDGER, forward: true, limit: 200, binary: false }])
    expect(read).toEqual({
      events: [{ kind: 'payment', tx: lockEntry.hash, ledger: LEDGER, from: A, to: B, amount: { currency: 'XRP', value: '1' }, memo: 'blume:test:lock', batch: OUTER }],
      complete: true,
      lastLedger: LEDGER,
      searchedMax: LEDGER,
    })
  })

  it('reports the sender side as the outer Batch plus both inners, each remembering the outer', async () => {
    serveFixture()
    const read = await accountEvents(cfg, A, LEDGER, LEDGER, 5000)
    expect(read.complete).toBe(true)
    expect(read.events).toHaveLength(3)
    expect(read.events).toEqual([
      { kind: 'outgoing', tx: OUTER, ledger: LEDGER, account: A, type: 'Batch', result: 'tesSUCCESS', sequence: outerSeq, inner: 2 },
      { kind: 'outgoing', tx: lockEntry.hash, ledger: LEDGER, account: A, type: 'Payment', result: 'tesSUCCESS', sequence: outerSeq + 1, destination: B, amount: { currency: 'XRP', value: '1' }, batch: OUTER },
      { kind: 'outgoing', tx: feeEntry.hash, ledger: LEDGER, account: A, type: 'Payment', result: 'tesSUCCESS', sequence: outerSeq + 2, destination: C, amount: { currency: 'XRP', value: '1' }, batch: OUTER },
    ])
    expect(read.events[0]).not.toHaveProperty('batch')
    expect(read.events[0]).not.toHaveProperty('destination')
    expect(read.events[0]).not.toHaveProperty('amount')
  })

  it('pages until the server stops sending a marker, keeping the outer and its inners together', async () => {
    const all = entries('A')
    stub.answer = (p) => {
      const page = Number(p.marker ?? 0)
      return { ...fixture.accountTx.A, transactions: all.slice(page, page + 1), ...(page + 1 < all.length ? { marker: page + 1 } : {}) }
    }
    const read = await accountEvents(cfg, A, LEDGER, LEDGER, 5000)
    expect(stub.asked).toHaveLength(3)
    expect(read.complete).toBe(true)
    expect(read.events.map((e) => e.tx)).toEqual([OUTER, lockEntry.hash, feeEntry.hash])
    expect(read.events.filter((e) => 'batch' in e && e.batch === OUTER)).toHaveLength(2)
  })
})
