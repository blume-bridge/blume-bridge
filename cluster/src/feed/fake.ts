import fs from 'node:fs'
import type { AccountSnap, LedgerEvent, State, XrplView } from '../types'
import { ledgerOrder } from '../machine'
import { XRPL_VIEW_BYTES, cutWindow, eventBytes } from './window'

/**
 * A pretend XRP Ledger, one file per node at /tmp/bridge-feed.json. Tests
 * write a different file into each container to play a lagging or lying
 * node. Shape: { ledger: number, events: LedgerEvent[], accounts?: { [address]: AccountSnap } }.
 */
export const FAKE_FEED_PATH = '/tmp/bridge-feed.json'

export interface FakeChain {
  ledger: number
  events: LedgerEvent[]
  accounts?: Record<string, AccountSnap>
}

export function readFakeChain(): FakeChain | null {
  try {
    const chain = JSON.parse(fs.readFileSync(FAKE_FEED_PATH, 'utf8')) as FakeChain
    if (typeof chain.ledger !== 'number' || !Array.isArray(chain.events)) return null
    return chain
  } catch {
    return null
  }
}

/** The next window, if the pretend ledger has closed it. Cut to whole ledgers under the cap like the real feed. */
export function fakeView(state: State, chain: FakeChain): XrplView | null {
  const cfg = state.config.xrpl
  const from = state.cursor.xrpl.ledger
  const full = from + cfg.windowLedgers
  if (chain.ledger < full) return null
  const skip = state.cursor.xrpl.skip ?? 0
  const sorted = chain.events.filter((e) => e.ledger > from && e.ledger <= full).sort(ledgerOrder(state.config)).slice(skip)
  const { to, events, partial } = cutWindow(sorted, { from, to: full, cap: cfg.maxEventsPerView, bytes: XRPL_VIEW_BYTES, pos: (e) => e.ledger, size: eventBytes })
  const accounts: Record<string, AccountSnap> = {}
  if (!partial) for (const addr of [cfg.lockAccount, cfg.fundingAccount]) accounts[addr] = chain.accounts?.[addr] ?? { sequence: 1, balanceDrops: '100000000' }
  return { src: 'xrpl', from, to, ...(skip > 0 ? { skip } : {}), events, accounts }
}
