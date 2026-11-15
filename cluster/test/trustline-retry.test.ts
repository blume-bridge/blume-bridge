import { describe, expect, it } from 'vitest'
import { tick } from '../src/machine'
import { NOW, accounts, baseState } from './helpers'

const HOUR = 3_600_000
const trustsets = (s: ReturnType<typeof baseState>) => Object.values(s.actions).filter((a) => a.reason.kind === 'trustline')

function failed(since: number) {
  const s = baseState()
  s.accounts = Object.fromEntries(Object.entries(accounts()).map(([k, v]) => [k, { ...v, ledger: 100 }]))
  s.tokens.PETAL.trustLine = 'failed'
  s.tokens.PETAL.trustLineFailedAt = since
  return s
}

describe('a refused trust line', () => {
  it('is tried again after an hour, not every round', () => {
    const soon = tick(failed(NOW), NOW + HOUR - 1).state
    expect(trustsets(soon)).toHaveLength(0)
    const later = tick(failed(NOW), NOW + HOUR).state
    expect(trustsets(later)).toHaveLength(1)
    expect(later.tokens.PETAL.trustLine).toBe('pending')
    expect(trustsets(later)[0].tx).toMatchObject({ TransactionType: 'TrustSet', Flags: 0x00020000 })
  })
  it('does not queue a second one while the first is in flight', () => {
    const once = tick(failed(NOW), NOW + HOUR).state
    const twice = tick(once, NOW + 3 * HOUR).state
    expect(trustsets(twice)).toHaveLength(1)
  })
})
