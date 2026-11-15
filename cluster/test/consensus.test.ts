import { describe, expect, it } from 'vitest'
import { consensusPercent, nodesNeeded } from '../scripts/lib/consensus'

/**
 * HotPocket's default threshold (80%) needs all three of three nodes, and a node that is a ledger behind then stalls the whole
 * cluster for good (the second rehearsal of 2026-10-18, Decision 39). The cluster runs at the percentage at which k nodes are enough.
 */
describe('consensusPercent: the threshold at which k of n nodes close a ledger', () => {
  it('gives the values the cluster will run with', () => {
    expect(consensusPercent(3, 2)).toBe(66)
    expect(consensusPercent(5, 3)).toBe(59)
    expect(consensusPercent(5, 4)).toBe(79)
    expect(consensusPercent(7, 4)).toBe(57)
    expect(consensusPercent(9, 5)).toBe(55)
    expect(consensusPercent(3, 3)).toBe(99)
    expect(consensusPercent(1, 1)).toBe(99)
  })

  it('needs exactly k nodes, whether HotPocket rounds the product up or takes its integer part plus one', () => {
    for (let n = 1; n <= 21; n++) {
      for (let k = 1; k <= n; k++) {
        if (2 * k <= n) continue
        const p = consensusPercent(n, k)
        expect(p, `n=${n} k=${k}`).toBeGreaterThanOrEqual(51)
        expect(p, `n=${n} k=${k}`).toBeLessThanOrEqual(99)
        expect(Math.ceil((n * p) / 100), `n=${n} k=${k} p=${p}`).toBe(k)
        expect(Math.floor((n * p) / 100) + 1, `n=${n} k=${k} p=${p}`).toBe(k)
      }
    }
  })

  it('refuses a k that is not more than half of n, since two groups could then both have enough', () => {
    for (let n = 1; n <= 21; n++) for (let k = 1; 2 * k <= n; k++) expect(() => consensusPercent(n, k), `n=${n} k=${k}`).toThrow(/k must be more than half of n/)
    expect(() => consensusPercent(3, 1)).toThrow()
    expect(() => consensusPercent(4, 2)).toThrow()
  })

  it('refuses numbers that are not a cluster', () => {
    for (const [n, k] of [[0, 0], [3, 0], [3, 4], [3.5, 2], [3, 1.5], [NaN, 2]]) expect(() => consensusPercent(n, k), `${n} ${k}`).toThrow(/whole numbers/)
  })
})

describe('nodesNeeded: how many of a UNL HotPocket needs at a percentage', () => {
  it('shows why 80% stalls three nodes and the chosen threshold does not', () => {
    expect(nodesNeeded(3, 80)).toBe(3) // one node a ledger behind: two are 67%, under 80%, so nobody closes or resyncs
    expect(nodesNeeded(3, consensusPercent(3, 2))).toBe(2)
    expect(nodesNeeded(5, 80)).toBe(4)
    expect(nodesNeeded(5, consensusPercent(5, 3))).toBe(3)
  })
})
