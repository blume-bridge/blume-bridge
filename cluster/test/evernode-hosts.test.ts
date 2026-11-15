import { describe, expect, it } from 'vitest'
import { operatorOf, placementProblems } from '../scripts/evernode-hosts'

/**
 * A host's operator can read the signing key of the instance on their machine, so a placement must never let one operator
 * hold enough instances to sign for the bridge (Decision 3, amended 2026-10-17).
 */
const host = (address: string, operator: string, extra: Partial<{ free: number; active: boolean; reputation: number }> = {}) => ({ address, operator, free: 2, active: true, reputation: 252, ...extra })

describe('operatorOf', () => {
  it('names whoever runs a host from its domain', () => {
    expect(operatorOf('node3.evernode-nl.info')).toBe('evernode-nl.info')
    expect(operatorOf('node2.evernode-nl.info')).toBe('evernode-nl.info')
    expect(operatorOf('zeb-a-nodew-02.xahaud.xyz')).toBe('xahaud.xyz')
    expect(operatorOf('node1.evernode.hostone.io')).toBe('hostone.io')
    expect(operatorOf('evernode.example.co.uk')).toBe('example.co.uk')
    expect(operatorOf('brittec5.com')).toBe('brittec5.com')
    expect(operatorOf('')).toBe('(no domain)')
  })
})

describe('placementProblems', () => {
  it('accepts one instance on each of three unrelated operators for a 2 of 3 cluster', () => {
    expect(placementProblems([host('rA', 'evernode-nl.info'), host('rB', 'xahaud.xyz'), host('rC', 'hostone.io')], 3, 2)).toEqual([])
  })

  it('refuses two instances of one operator when two can sign', () => {
    const p = placementProblems([host('rA', 'xahaud.xyz'), host('rB', 'xahaud.xyz'), host('rC', 'hostone.io')], 3, 2)
    expect(p.join()).toMatch(/xahaud\.xyz would run 2 of the 3 instances, and 2 of them can sign/)
  })

  it('allows an operator to hold fewer than k: one of a 2-of-3, two of a 3-of-5', () => {
    expect(placementProblems([host('rA', 'a.io'), host('rB', 'a.io'), host('rC', 'b.io'), host('rD', 'c.io'), host('rE', 'd.io')], 5, 3)).toEqual([])
    expect(placementProblems([host('rA', 'a.io'), host('rB', 'a.io'), host('rC', 'a.io'), host('rD', 'c.io'), host('rE', 'd.io')], 5, 3).join()).toMatch(/a\.io would run 3 of the 5/)
  })

  it('wants a host for every instance, once, active, with a free slot and a reputation', () => {
    expect(placementProblems([host('rA', 'a.io'), host('rB', 'b.io')], 3, 2).join()).toMatch(/2 host\(s\) for 3 instances/)
    expect(placementProblems([host('rA', 'a.io'), host('rA', 'b.io'), host('rC', 'c.io')], 3, 2).join()).toMatch(/listed twice/)
    const bad = placementProblems([host('rA', 'a.io', { active: false }), host('rB', 'b.io', { free: 0 }), host('rC', 'c.io', { reputation: 90 })], 3, 2).join('|')
    expect(bad).toMatch(/rA is not active/)
    expect(bad).toMatch(/rB has no free slot/)
    expect(bad).toMatch(/rC has reputation 90/)
  })
})

describe('a host with no lease offer', () => {
  const host = (offers: number | null | undefined) => ({ address: 'rA', operator: 'a.example', free: 2, active: true, reputation: 250, ...(offers === undefined ? {} : { offers }) })
  it('is refused, whatever the registry says about its free slots', () => {
    expect(placementProblems([host(0), { ...host(1), address: 'rB', operator: 'b.example' }, { ...host(3), address: 'rC', operator: 'c.example' }], 3, 2).join()).toMatch(/rA has no lease offer open/)
  })
  it('is let through when its offers were not asked for or could not be read', () => {
    expect(placementProblems([host(undefined), { ...host(null), address: 'rB', operator: 'b.example' }, { ...host(2), address: 'rC', operator: 'c.example' }], 3, 2)).toEqual([])
  })
})
