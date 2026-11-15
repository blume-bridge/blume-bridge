import { describe, expect, it } from 'vitest'
import * as dec from '../src/dec'

/**
 * A decimal that cannot be parsed must be rejected, never computed. An
 * unbounded exponent used to make every node allocate a number with hundreds
 * of millions of digits on the same agreed view, which halts the cluster for
 * good: there is no admin key and every honest node hangs identically.
 */
describe('decimal bounds', () => {
  it('refuses an exponent that would allocate an enormous number', () => {
    for (const bad of ['1e900000000', '1e97', '1E-97', '0.1e1000000']) expect(() => dec.parse(bad)).toThrow(/exponent out of range/)
  })
  it('refuses a mantissa longer than any ledger carries', () => {
    expect(() => dec.parse('1'.repeat(65))).toThrow(/too many digits/)
    expect(() => dec.parse('0.' + '1'.repeat(65))).toThrow(/too many digits/)
  })
  it('still takes every value the ledgers actually produce', () => {
    expect(dec.parse('1e96')).toBeGreaterThan(0n)
    expect(dec.parse('1e-96')).toBe(0n)
    expect(dec.format(dec.parse('0.000000000000001'))).toBe('0.000000000000001')
    expect(dec.format(dec.parse('99999999999999900000000000000000000000'))).toBe('99999999999999900000000000000000000000')
    expect(dec.format(dec.parse('1000000000000'))).toBe('1000000000000')
    expect(dec.format(dec.parse('1.5e3'))).toBe('1500')
  })
  it('rejects the intent amount that would hang a consensus round', () => {
    // The call site wraps parse in try/catch, so a throw is the whole fix: it falls to the existing error path.
    expect(() => dec.parse('1e900000000')).toThrow()
  })
})
