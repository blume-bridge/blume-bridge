import { describe, expect, it } from 'vitest'
import { evmCoverage, xrplCoverage } from '../src/feed/coverage'

describe('xrplCoverage', () => {
  it('covers the whole span when the read completed and the server searched it all', () => {
    expect(xrplCoverage(1200, true, 1150, 1200)).toBe(1200)
    expect(xrplCoverage(1200, true, 1001, 1300)).toBe(1200)
  })
  it('stops before the last ledger read when pages ran out', () => {
    expect(xrplCoverage(1200, false, 1050, 1200)).toBe(1049)
  })
  it('never trusts a server past the ledger it says it searched', () => {
    expect(xrplCoverage(1200, true, 1100, 1120)).toBe(1120)
    expect(xrplCoverage(1200, false, 1050, 1020)).toBe(1020)
  })
  it('takes the paged answer as is when the server did not report a range', () => {
    expect(xrplCoverage(1200, true, 1100, null)).toBe(1200)
    expect(xrplCoverage(1200, false, 1050, null)).toBe(1049)
  })
  it('can cover nothing', () => {
    expect(xrplCoverage(1200, false, 1001, null)).toBe(1000)
    expect(xrplCoverage(1200, true, 1001, 900)).toBe(900)
  })
})

describe('evmCoverage', () => {
  it('covers the span when the answering node is far enough ahead', () => {
    expect(evmCoverage(500, 600, 2)).toBe(500)
    expect(evmCoverage(500, 502, 2)).toBe(500)
  })
  it('stops at the answering node head minus confirmations', () => {
    expect(evmCoverage(500, 501, 2)).toBe(499)
    expect(evmCoverage(500, 300, 2)).toBe(298)
  })
})
