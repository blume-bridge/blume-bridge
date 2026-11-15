import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { MAX_CODE_BYTES, MAX_GZ_BYTES, MAX_UPGRADERS, compileProblem, decide, isUpgrader, keyProblems, parseUpgrade, readState, sha256, startState, type UpgradeMessage } from '../src/upgrade'

/** The rules for changing a running cluster's code, with no files and no HotPocket. */
const KEY_A = 'ed' + 'a'.repeat(64)
const KEY_B = 'ed' + 'b'.repeat(64)
const V1 = 'exports.contract = async () => {}\n'
const NOW = 1_800_000_000_000

const state = () => startState(sha256(V1), [KEY_A], NOW)
const gz = (code: string | Buffer) => gzipSync(code).toString('base64')
const codeMsg = (code: string, version = 2): UpgradeMessage => ({ op: 'code', version, hash: sha256(code), gz: gz(code) })
const raw = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))

describe('upgrader keys', () => {
  it('are HotPocket user keys, a few, each once', () => {
    expect(keyProblems([KEY_A, KEY_B])).toEqual([])
    expect(keyProblems([])).toEqual([])
    expect(keyProblems('ed' + 'a'.repeat(64))[0]).toMatch(/must be a list/)
    expect(keyProblems(['nope'])[0]).toMatch(/is not a HotPocket user key/)
    expect(keyProblems(['ED' + 'A'.repeat(64)])[0]).toMatch(/is not a HotPocket user key/)
    expect(keyProblems([KEY_A, KEY_A])[0]).toMatch(/listed twice/)
    expect(keyProblems(Array.from({ length: MAX_UPGRADERS + 1 }, (_, i) => 'ed' + String(i).repeat(64).slice(0, 64)))[0]).toMatch(/at most/)
  })
  it('decide who may change the code: any one of them', () => {
    const s = startState(sha256(V1), [KEY_A, KEY_B], NOW)
    expect(isUpgrader(s, KEY_A)).toBe(true)
    expect(isUpgrader(s, KEY_B)).toBe(true)
    expect(isUpgrader(s, 'ed' + 'c'.repeat(64))).toBe(false)
    expect(isUpgrader(startState(sha256(V1), [], NOW), KEY_A)).toBe(false)
  })
})

describe('the state', () => {
  it('starts at version 1 with the hash of the code it was bundled with', () => {
    expect(state()).toEqual({ version: 1, hash: sha256(V1), upgraders: [KEY_A], history: [{ version: 1, what: 'start', hash: sha256(V1), at: NOW }] })
  })
  it('is read back only when it is sound', () => {
    expect(readState(JSON.parse(JSON.stringify(state())))).toEqual({ state: state() })
    for (const bad of [null, 'x', {}, { ...state(), version: 0 }, { ...state(), version: 1.5 }, { ...state(), hash: 'nope' }, { ...state(), upgraders: ['x'] }, { ...state(), history: 'x' }]) {
      expect(readState(bad), JSON.stringify(bad)).toHaveProperty('error')
    }
  })
})

describe('parsing a message', () => {
  it('leaves everything that is not an upgrade to the app', () => {
    expect(parseUpgrade(raw({ type: 'transfer', id: 'x' }))).toBeNull()
    expect(parseUpgrade(raw('not json'))).toBeNull()
    expect(parseUpgrade(raw('[1,2]'))).toBeNull()
    expect(parseUpgrade(raw('null'))).toBeNull()
    expect(parseUpgrade(Buffer.alloc(0))).toBeNull()
    expect(parseUpgrade(Buffer.from([0xff, 0xfe, 0x00]))).toBeNull()
  })
  it('reads the three operations and echoes the request id', () => {
    expect(parseUpgrade(raw({ type: 'upgrade', id: 'r1', op: 'code', version: 2, hash: 'a'.repeat(64), gz: 'AAAA' }))).toEqual({ message: { op: 'code', version: 2, hash: 'a'.repeat(64), gz: 'AAAA' }, id: 'r1' })
    expect(parseUpgrade(raw({ type: 'upgrade', op: 'rollback', version: 3 }))).toEqual({ message: { op: 'rollback', version: 3 }, id: undefined })
    expect(parseUpgrade(raw({ type: 'upgrade', op: 'keys', version: 4, upgraders: [KEY_B] }))).toEqual({ message: { op: 'keys', version: 4, upgraders: [KEY_B] }, id: undefined })
    expect(parseUpgrade(raw('  \n{"type":"upgrade","op":"rollback","version":2}'))).toHaveProperty('message')
  })
  it('tells the sender when a message that says it is an upgrade is not one', () => {
    const bad = (v: object) => parseUpgrade(raw({ type: 'upgrade', ...v })) as { error: string }
    expect(bad({ op: 'code', hash: 'a'.repeat(64), gz: 'AA' }).error).toMatch(/version/)
    expect(bad({ op: 'code', version: 0, hash: 'a'.repeat(64), gz: 'AA' }).error).toMatch(/version/)
    expect(bad({ op: 'code', version: 2, hash: 'XYZ', gz: 'AA' }).error).toMatch(/hash/)
    expect(bad({ op: 'code', version: 2, hash: 'a'.repeat(64), gz: '' }).error).toMatch(/gz/)
    expect(bad({ op: 'delete', version: 2 }).error).toMatch(/unknown op/)
    expect(bad({ version: 2 }).error).toMatch(/unknown op/)
    expect(parseUpgrade(raw({ type: 'upgrade', id: 'x'.repeat(200), op: 'nope', version: 2 })) as { id: string }).toMatchObject({ id: 'x'.repeat(64) })
  })
})

describe('compiling', () => {
  it('accepts what Node accepts as a CommonJS file, a top-level return included', () => {
    expect(compileProblem(V1)).toBeNull()
    expect(compileProblem('if (x) return\nmodule.exports = {}')).toBeNull()
  })
  it('names a syntax error', () => {
    expect(compileProblem('exports.contract = (')).toMatch(/Unexpected|Unterminated|expected/i)
    expect(compileProblem('const = 1')).not.toBeNull()
  })
})

describe('a code upgrade', () => {
  it('is accepted with the next version, a matching hash and code that compiles', () => {
    const code = 'exports.contract = async () => { /* v2 */ }\n'
    const d = decide(state(), codeMsg(code), NOW + 5, null)
    expect(d).toMatchObject({ ok: true, install: { code: Buffer.from(code) } })
    if (!d.ok) throw new Error('unreachable')
    expect(d.next).toEqual({
      version: 2,
      hash: sha256(code),
      upgraders: [KEY_A],
      history: [{ version: 1, what: 'start', hash: sha256(V1), at: NOW }, { version: 2, what: 'code', hash: sha256(code), at: NOW + 5 }],
    })
  })
  it('is refused unless it carries exactly the next version, so an old message cannot be played again', () => {
    const msg = codeMsg('exports.contract = () => {}\n', 2)
    for (const version of [1, 3, 100]) expect(decide(state(), { ...msg, version } as UpgradeMessage, NOW, null)).toEqual({ ok: false, error: `version must be 2 (this cluster is at 1)` })
    const at2 = (decide(state(), msg, NOW, null) as { next: ReturnType<typeof state> }).next
    expect(decide(at2, msg, NOW, null)).toMatchObject({ ok: false, error: expect.stringContaining('version must be 3') })
  })
  it('is refused when the code is not what its hash says', () => {
    const msg = codeMsg('exports.contract = () => {}\n')
    expect(decide(state(), { ...msg, hash: sha256('something else') } as UpgradeMessage, NOW, null)).toEqual({ ok: false, error: 'the code does not match its hash' })
  })
  it('is refused when it is not gzip data, or unpacks past the limit', () => {
    const notGz = decide(state(), { op: 'code', version: 2, hash: sha256('x'), gz: Buffer.from('plainly not gzip').toString('base64') }, NOW, null)
    expect(notGz).toMatchObject({ ok: false, error: expect.stringContaining('not gzip data') })
    const bomb = Buffer.alloc(MAX_CODE_BYTES + 1, 0x20)
    const big = decide(state(), { op: 'code', version: 2, hash: sha256(bomb), gz: gz(bomb) }, NOW, null)
    expect(big).toMatchObject({ ok: false, error: expect.stringContaining('not gzip data within') })
    const huge = decide(state(), { op: 'code', version: 2, hash: sha256('x'), gz: 'A'.repeat(Math.ceil((MAX_GZ_BYTES * 4) / 3) + 100) }, NOW, null)
    expect(huge).toMatchObject({ ok: false, error: expect.stringContaining('compressed') })
  })
  it('is refused when the code does not compile', () => {
    const d = decide(state(), codeMsg('exports.contract = (\n'), NOW, null)
    expect(d).toMatchObject({ ok: false, error: expect.stringContaining('does not compile') })
  })
  it('may carry the code that is running (a re-install still counts as a version)', () => {
    expect(decide(state(), codeMsg(V1), NOW, null)).toMatchObject({ ok: true })
  })
  it('keeps the last twenty history entries', () => {
    let s = state()
    for (let v = 2; v <= 30; v++) {
      const d = decide(s, codeMsg(`exports.contract = () => ${v}\n`, v), NOW + v, null)
      if (!d.ok) throw new Error(d.error)
      s = d.next
    }
    expect(s.version).toBe(30)
    expect(s.history).toHaveLength(20)
    expect(s.history[19]).toMatchObject({ version: 30, what: 'code' })
    expect(s.history[0].version).toBe(11)
  })
  it('gives every node the same next state from the same message and time', () => {
    const msg = codeMsg('exports.contract = () => 7\n')
    expect(JSON.stringify(decide(state(), msg, NOW + 9, null))).toBe(JSON.stringify(decide(state(), msg, NOW + 9, null)))
  })
})

describe('a rollback', () => {
  it('swaps in the previous version, whose hash it is told', () => {
    const d = decide(state(), { op: 'rollback', version: 2 }, NOW + 1, sha256('previous'))
    expect(d).toMatchObject({ ok: true, install: { swap: true }, next: { version: 2, hash: sha256('previous') } })
  })
  it('is refused when there is no previous version, or the version is wrong', () => {
    expect(decide(state(), { op: 'rollback', version: 2 }, NOW, null)).toEqual({ ok: false, error: 'there is no previous version to go back to' })
    expect(decide(state(), { op: 'rollback', version: 5 }, NOW, 'x'.repeat(64))).toMatchObject({ ok: false })
  })
})

describe('replacing the upgrader keys', () => {
  it('takes a new list and keeps the code', () => {
    const d = decide(state(), { op: 'keys', version: 2, upgraders: [KEY_B] }, NOW, null)
    expect(d).toMatchObject({ ok: true, install: null, next: { version: 2, hash: sha256(V1), upgraders: [KEY_B] } })
  })
  it('refuses a bad list, and refuses to remove the last key, which would freeze the code for good', () => {
    expect(decide(state(), { op: 'keys', version: 2, upgraders: [] }, NOW, null)).toMatchObject({ ok: false, error: expect.stringContaining('never be changed again') })
    expect(decide(state(), { op: 'keys', version: 2, upgraders: ['nope'] }, NOW, null)).toMatchObject({ ok: false })
    expect(decide(state(), { op: 'keys', version: 2, upgraders: undefined as unknown as string[] }, NOW, null)).toMatchObject({ ok: false })
  })
})
