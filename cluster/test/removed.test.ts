import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyEvmView, applyView, createTestBurn, validateIntent } from '../src/machine'
import { ALICE, EVM, NOW, baseState, evmState, feeOf, intent, lockOf, view } from './helpers'

/**
 * What the fee plan deleted stays deleted. A fee that is set to zero is still a
 * fee path; a fee that is gone has no path, so these look for the code itself and
 * for any behaviour that could only come from it.
 */

function sources(dir: string): { file: string; text: string }[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? sources(p) : e.name.endsWith('.ts') ? [{ file: path.relative(path.join(__dirname, '..'), p), text: fs.readFileSync(p, 'utf8') }] : []
  })
}
const SRC = sources(path.join(__dirname, '..', 'src'))
const mentions = (pattern: RegExp, except: string[] = []) => SRC.filter((s) => !except.includes(s.file) && pattern.test(s.text)).map((s) => s.file)

describe('no token fee anywhere', () => {
  it('has no code that takes a cut of the token', () => {
    expect(mentions(/tokenFee|feeRate|feeMode|feeFallback/)).toEqual([])
    // the surplus is dust, never a fee: feeUnits only appears where an old snapshot is read
    expect(mentions(/feeUnits/, ['src/state.ts'])).toEqual([])
  })
  it('has no funding rounds, contributors or pool-priced caps', () => {
    // src/state.ts names them only to read an old snapshot: it refuses one whose rounds still owe their contributors
    expect(mentions(/RoundRec|\.rounds\b|readPool|poolCap|MIN_POOL|listingCapXrp|targetXrp|targetSplit|capMultiplier|fundingWindowMs|contributor/i, ['src/state.ts'])).toEqual([])
    expect(mentions(/listCapUnits/, ['src/state.ts'])).toEqual([])
  })
  it('reads no market: no pool and no order book', () => {
    expect(mentions(/amm_info|book_offers/)).toEqual([])
  })
  it('a leftover feeRate in an old config changes nothing: the lock mints the full amount', () => {
    const { state: s, transfer } = intent(baseState())
    const legacy = { ...s, config: { ...s.config, params: { ...s.config.params, feeRate: { num: 3, den: 1000 } } as never } }
    const { state } = applyView(legacy, view(legacy, [feeOf(transfer), lockOf(transfer)]), NOW + 1000)
    expect(state.transfers[transfer.id]).toMatchObject({ step: 3, receive: '1000' })
    expect(state.tokens.PETAL.lockedUnits).toBe('1000')
    expect(state.tokens.PETAL.dustUnits).toBe('0')
  })
  it('a leftover feeRate takes nothing on the way out either', () => {
    const s = evmState()
    s.config = { ...s.config, params: { ...s.config.params, feeRate: { num: 3, den: 1000 } } as never }
    s.tokens.PETAL.evmAddress = '0x1111111111111111111111111111111111111111'
    s.tokens.PETAL.lockedUnits = '500'
    const burn = { kind: 'burn' as const, tx: '0xb', block: 1002, logIndex: 0, token: s.tokens.PETAL.evmAddress, from: EVM, amountWei: '10000000000000000000', rAddress: ALICE, nonce: '1' }
    const r = applyEvmView(s, { src: 'evm', from: s.cursor.evm!.block, to: s.cursor.evm!.block + 10, events: [burn], listings: {} }, NOW).state
    expect(Object.values(r.transfers)[0]).toMatchObject({ amount: '10', receive: '10' })
    expect(r.tokens.PETAL.lockedUnits).toBe('490')
    // and a test burn
    const t = baseState()
    t.tokens.PETAL.lockedUnits = '100'
    t.config = { ...t.config, params: { ...t.config.params, feeRate: { num: 3, den: 1000 } } as never }
    expect(createTestBurn(t, { sym: 'PETAL', amount: '40', to: ALICE, from: EVM }, 'feedfacefeedface', NOW).transfer.receive).toBe('40')
  })
  it('refuses a request that asks for it', () => {
    expect(validateIntent(baseState(), { dir: 'in', sym: 'PETAL', amount: '1', from: ALICE, to: EVM, fee: 'token' })).toEqual({ ok: false, error: 'the token fee no longer exists' })
  })
})
