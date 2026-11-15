import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import type { HpContext } from 'hotpocket-nodejs-contract'
import { afterAll, describe, expect, it } from 'vitest'
import { runRound } from '../src/loader-core'
import { sha256 } from '../src/upgrade'
import { cleanupTmp, tmpDir } from './ops-helpers'

/**
 * The loader against a fake HotPocket context and a real directory: what a node does with an upgrade, with a broken app, and
 * with everyone else's input. The app is a few lines that note which version ran and echo what it was given.
 */
afterAll(cleanupTmp)

const UPGRADER = 'ed' + 'a'.repeat(64)
const OTHER_UPGRADER = 'ed' + 'b'.repeat(64)
const STRANGER = 'ed' + 'c'.repeat(64)
const NOW = 1_800_000_000_000

const app = (tag: string) => `
const fs = require('fs'), path = require('path')
exports.contract = async (ctx) => {
  fs.appendFileSync(path.join(__dirname, 'ran.log'), '${tag}' + (ctx.readonly ? ' read' : '') + '\\n')
  for (const u of ctx.users.list()) for (const i of u.inputs) await u.send({ app: '${tag}', saw: (await ctx.users.read(i)).toString() })
}
`
/** An app that counts the inputs it is handed and reads none of them, so a test can tell the loader's reads from the app's. */
const counting = (tag: string) => `
const fs = require('fs'), path = require('path')
exports.contract = async (ctx) => {
  const n = ctx.users.list().reduce((sum, u) => sum + u.inputs.length, 0)
  fs.appendFileSync(path.join(__dirname, 'ran.log'), '${tag} ' + n + '\\n')
}
`
const BROKEN_AT_LOAD = `throw new Error('this version cannot start')\n`

interface Sent {
  [k: string]: any
}

function bundle(upgraders: string[] = [UPGRADER], code = app('v1')) {
  const dir = tmpDir('loader-')
  fs.writeFileSync(path.join(dir, 'app.js'), code)
  fs.writeFileSync(path.join(dir, 'genesis.json'), JSON.stringify(upgraders.length ? { upgrade: { upgraders } } : {}))
  const logs: string[] = []
  let timestamp = NOW
  /** One round: each input is { key, body }. Returns what each key was sent, and which inputs the loader read. */
  async function round(inputs: { key: string; body: string | Buffer }[] = [], opts: { readonly?: boolean } = {}) {
    const parts: Buffer[] = []
    let offset = 0
    const users = new Map<string, { publicKey: string; inputs: [number, number][]; sent: Sent[]; send(m: Sent): Promise<void> }>()
    for (const i of inputs) {
      const buf = Buffer.isBuffer(i.body) ? i.body : Buffer.from(i.body)
      parts.push(buf)
      let u = users.get(i.key)
      if (!u) {
        const sent: Sent[] = []
        u = { publicKey: i.key, inputs: [], sent, send: async (m) => void sent.push(m) }
        users.set(i.key, u)
      }
      u.inputs.push([offset, buf.length])
      offset += buf.length
    }
    const all = Buffer.concat(parts)
    const reads: [number, number][] = []
    const ctx = {
      contractId: 'test-contract',
      publicKey: 'edNODE',
      readonly: !!opts.readonly,
      timestamp: opts.readonly ? 0 : (timestamp += 1000),
      lclSeqNo: 1,
      users: {
        list: () => [...users.values()],
        find: (k: string) => users.get(k),
        count: () => users.size,
        read: async (input: [number, number]) => {
          reads.push(input)
          return all.subarray(input[0], input[0] + input[1])
        },
      },
    } as unknown as HpContext
    await runRound(ctx, { dir, log: (l) => logs.push(l) })
    return { sent: (key: string) => users.get(key)?.sent ?? [], reads }
  }
  const file = (name: string) => path.join(dir, name)
  const read = (name: string) => fs.readFileSync(file(name), 'utf8')
  const state = () => JSON.parse(read('upgrade.json'))
  const ran = () => (fs.existsSync(file('ran.log')) ? read('ran.log').trim().split('\n') : [])
  return { dir, logs, round, file, read, state, ran }
}

const upgradeMsg = (code: string, version: number, id = 't') => JSON.stringify({ type: 'upgrade', id, op: 'code', version, hash: sha256(code), gz: gzipSync(code).toString('base64') })

describe('the first round', () => {
  it('records the version, the hash and the upgrader keys from the genesis, and runs the app', async () => {
    const b = bundle([UPGRADER, OTHER_UPGRADER])
    await b.round([{ key: STRANGER, body: 'hello' }])
    expect(b.state()).toMatchObject({ version: 1, hash: sha256(b.read('app.js')), upgraders: [UPGRADER, OTHER_UPGRADER] })
    expect(b.ran()).toEqual(['v1'])
  })
  it('gives a bundle with no upgrader key a state in which the code can never change', async () => {
    const b = bundle([])
    await b.round()
    expect(b.state().upgraders).toEqual([])
    const code = app('v2')
    const r = await b.round([{ key: UPGRADER, body: upgradeMsg(code, 2) }])
    expect(b.read('app.js')).toContain("'v1'")
    expect(r.sent(UPGRADER)[0]).toMatchObject({ app: 'v1' }) // it went to the app, which does not know it
  })
  it('does not trust upgrader keys that are not keys', async () => {
    const b = bundle(['not-a-key'])
    await b.round()
    expect(b.state().upgraders).toEqual([])
    expect(b.logs.join('\n')).toMatch(/unusable upgrader keys/)
  })
  it('writes nothing in a read-only round, even the first', async () => {
    const b = bundle()
    await b.round([{ key: STRANGER, body: '{"type":"status"}' }], { readonly: true })
    expect(fs.existsSync(b.file('upgrade.json'))).toBe(false)
    expect(b.ran()).toEqual(['v1 read'])
  })
})

describe('an upgrade from an upgrader key', () => {
  it('installs the code, keeps the old one, and the new code handles that very round', async () => {
    const b = bundle()
    await b.round()
    const v2 = app('v2')
    const r = await b.round([{ key: UPGRADER, body: upgradeMsg(v2, 2, 'req-1') }, { key: STRANGER, body: 'ordinary input' }])
    expect(b.read('app.js')).toBe(v2)
    expect(b.read('app.prev.js')).toBe(app('v1'))
    expect(b.state()).toMatchObject({ version: 2, hash: sha256(v2) })
    expect(b.state().history.map((h: { what: string }) => h.what)).toEqual(['start', 'code'])
    // no output to the upgrader (an output is compared across nodes); the outcome is in the state for a code read to return
    expect(r.sent(UPGRADER)).toEqual([])
    expect(b.state().last).toEqual({ id: 'req-1', ok: true, op: 'code', by: UPGRADER.slice(0, 12), at: NOW + 2000 })
    // the app never saw the upgrade message; the stranger's input reached the new app
    expect(r.sent(STRANGER)).toEqual([{ app: 'v2', saw: 'ordinary input' }])
    expect(b.ran()).toEqual(['v1', 'v2'])
    expect(fs.existsSync(b.file('app.tmp.js'))).toBe(false)
  })
  it('sends the upgrader nothing at all in a consensus round, because outputs are compared across nodes', async () => {
    const b = bundle()
    await b.round()
    for (const body of [upgradeMsg(app('v2'), 2), upgradeMsg(app('v3'), 99), '{"type":"upgrade","op":"nope","version":3}', JSON.stringify({ type: 'upgrade', op: 'rollback', version: 3 })]) {
      const r = await b.round([{ key: UPGRADER, body }])
      expect(r.sent(UPGRADER), body.slice(0, 40)).toEqual([])
    }
  })
  it('reports the outcome of the latest message in a code read', async () => {
    const b = bundle()
    await b.round()
    await b.round([{ key: UPGRADER, body: upgradeMsg(app('v2'), 5, 'r9') }])
    const read = await b.round([{ key: STRANGER, body: '{"type":"code"}' }], { readonly: true })
    expect(read.sent(STRANGER)[0]).toMatchObject({ last: { id: 'r9', ok: false, error: expect.stringContaining('version must be 2') } })
  })
  it('can be followed by another, and the version keeps counting', async () => {
    const b = bundle()
    await b.round()
    await b.round([{ key: UPGRADER, body: upgradeMsg(app('v2'), 2) }])
    await b.round([{ key: UPGRADER, body: upgradeMsg(app('v3'), 3) }])
    expect(b.state().version).toBe(3)
    expect(b.read('app.prev.js')).toBe(app('v2'))
    expect(b.ran()).toEqual(['v1', 'v2', 'v3'])
  })
  it('is refused with a reason, and changes nothing, when the version, the hash or the code is wrong', async () => {
    const b = bundle()
    await b.round()
    const good = app('v2')
    const cases: [string, string, RegExp][] = [
      ['an old version', upgradeMsg(good, 1), /version must be 2/],
      ['a skipped version', upgradeMsg(good, 3), /version must be 2/],
      ['a wrong hash', JSON.stringify({ type: 'upgrade', op: 'code', version: 2, hash: sha256('other'), gz: gzipSync(good).toString('base64') }), /does not match its hash/],
      ['code that does not compile', upgradeMsg('exports.contract = (\n', 2), /does not compile/],
      ['something that is not gzip', JSON.stringify({ type: 'upgrade', op: 'code', version: 2, hash: sha256('x'), gz: Buffer.from('nope').toString('base64') }), /not gzip/],
      ['a malformed message', JSON.stringify({ type: 'upgrade', op: 'code', version: 2 }), /hash must be/],
    ]
    for (const [what, body, error] of cases) {
      const r = await b.round([{ key: UPGRADER, body }])
      expect(r.sent(UPGRADER), what).toEqual([])
      expect(b.state().last, what).toMatchObject({ ok: false, error: expect.stringMatching(error) })
      expect(b.state().version, what).toBe(1)
      expect(b.read('app.js'), what).toBe(app('v1'))
    }
  })
  it('refuses an oversized message without reading it', async () => {
    const b = bundle()
    await b.round()
    const r = await b.round([{ key: UPGRADER, body: Buffer.alloc(5 * 1024 * 1024, 0x61) }])
    expect(b.state().last).toMatchObject({ ok: false, error: expect.stringContaining('over the') })
    expect(r.reads).toHaveLength(0)
  })
  it('hands the app any other message from an upgrader', async () => {
    const b = bundle()
    await b.round()
    const r = await b.round([{ key: UPGRADER, body: '{"type":"transfer","amount":"1"}' }, { key: UPGRADER, body: 'plain text' }])
    expect(r.sent(UPGRADER).map((m) => m.saw)).toEqual(['{"type":"transfer","amount":"1"}', 'plain text'])
  })
})

describe('anyone else', () => {
  it('cannot upgrade, is not even read, and the message goes to the app like any other', async () => {
    const b = bundle([UPGRADER], counting('v1'))
    await b.round()
    const msg = upgradeMsg(app('evil'), 2)
    const r = await b.round([{ key: STRANGER, body: msg }])
    expect(r.reads).toHaveLength(0) // the loader never looked at it
    expect(b.read('app.js')).toBe(counting('v1'))
    expect(b.state().version).toBe(1)
    expect(b.ran()).toEqual(['v1 0', 'v1 1']) // the app was handed the stranger's input
  })
  it('cannot use a key that was replaced', async () => {
    const b = bundle([UPGRADER])
    await b.round()
    await b.round([{ key: UPGRADER, body: JSON.stringify({ type: 'upgrade', op: 'keys', version: 2, upgraders: [OTHER_UPGRADER] }) }])
    expect(b.state().upgraders).toEqual([OTHER_UPGRADER])
    await b.round([{ key: UPGRADER, body: upgradeMsg(app('v3'), 3) }])
    expect(b.read('app.js')).toBe(app('v1'))
    await b.round([{ key: OTHER_UPGRADER, body: upgradeMsg(app('v3'), 3) }])
    expect(b.read('app.js')).toBe(app('v3'))
  })
})

describe('a version that will not run', () => {
  it('falls back to the one before, says why, and still takes the next upgrade', async () => {
    const b = bundle()
    await b.round()
    // compiles, so it is accepted, and throws when it is loaded
    await b.round([{ key: UPGRADER, body: upgradeMsg(BROKEN_AT_LOAD, 2) }])
    expect(b.state().version).toBe(2)
    expect(b.ran()).toEqual(['v1', 'v1']) // the previous app ran in the round that installed the broken one
    expect(b.logs.join('\n')).toMatch(/app\.js: this version cannot start/)
    const read = await b.round([{ key: STRANGER, body: '{"type":"code","id":"c1"}' }], { readonly: true })
    expect(read.sent(STRANGER)[0]).toMatchObject({ type: 'code', id: 'c1', version: 2, loaded: 'prev', error: expect.stringContaining('this version cannot start') })
    // and the fix goes in
    await b.round([{ key: UPGRADER, body: upgradeMsg(app('v3'), 3) }])
    expect(b.ran()).toEqual(['v1', 'v1', 'v3'])
  })
  it('does nothing, and says so, when no version loads, but still accepts an upgrade', async () => {
    const b = bundle([UPGRADER], BROKEN_AT_LOAD)
    await b.round([{ key: STRANGER, body: 'x' }])
    expect(b.ran()).toEqual([])
    expect(b.logs.join('\n')).toMatch(/no app could be loaded/)
    const r = await b.round([{ key: UPGRADER, body: upgradeMsg(app('v2'), 2) }, { key: STRANGER, body: 'y' }])
    expect(r.sent(STRANGER)).toEqual([{ app: 'v2', saw: 'y' }])
  })
  it('rejects code that exports no contract function by falling back', async () => {
    const b = bundle()
    await b.round()
    await b.round([{ key: UPGRADER, body: upgradeMsg('exports.other = 1\n', 2) }])
    expect(b.ran()).toEqual(['v1', 'v1'])
    expect(b.logs.join('\n')).toMatch(/exports no contract function/)
  })
})

describe('a rollback', () => {
  it('puts the previous version back, and a second one swaps again', async () => {
    const b = bundle()
    await b.round()
    await b.round([{ key: UPGRADER, body: upgradeMsg(app('v2'), 2) }])
    const r = await b.round([{ key: UPGRADER, body: JSON.stringify({ type: 'upgrade', id: 'rb', op: 'rollback', version: 3 }) }, { key: STRANGER, body: 'z' }])
    expect(b.read('app.js')).toBe(app('v1'))
    expect(b.read('app.prev.js')).toBe(app('v2'))
    expect(b.state()).toMatchObject({ version: 3, hash: sha256(app('v1')) })
    expect(b.state().last).toMatchObject({ ok: true, op: 'rollback', id: 'rb' })
    expect(r.sent(UPGRADER)).toEqual([])
    expect(r.sent(STRANGER)).toEqual([{ app: 'v1', saw: 'z' }])
    await b.round([{ key: UPGRADER, body: JSON.stringify({ type: 'upgrade', op: 'rollback', version: 4 }) }])
    expect(b.read('app.js')).toBe(app('v2'))
  })
  it('is refused when there is nothing to go back to', async () => {
    const b = bundle()
    await b.round()
    await b.round([{ key: UPGRADER, body: JSON.stringify({ type: 'upgrade', op: 'rollback', version: 2 }) }])
    expect(b.state().last).toMatchObject({ ok: false, error: 'there is no previous version to go back to' })
  })
})

describe('replacing the upgrader keys', () => {
  it('works for an upgrader, leaves the code alone, and is refused when it would leave no key', async () => {
    const b = bundle()
    await b.round()
    const before = b.state().hash
    await b.round([{ key: UPGRADER, body: JSON.stringify({ type: 'upgrade', op: 'keys', version: 2, upgraders: [UPGRADER, OTHER_UPGRADER] }) }])
    expect(b.state().last).toMatchObject({ ok: true, op: 'keys' })
    expect(b.state()).toMatchObject({ version: 2, hash: before, upgraders: [UPGRADER, OTHER_UPGRADER] })
    await b.round([{ key: UPGRADER, body: JSON.stringify({ type: 'upgrade', op: 'keys', version: 3, upgraders: [] }) }])
    expect(b.state().last).toMatchObject({ ok: false, error: expect.stringContaining('never be changed again') })
    expect(b.state().upgraders).toHaveLength(2)
  })
})

describe('a swap that was cut off', () => {
  it('is undone from the recorded hash: a half-written app is replaced by the copy that matches', async () => {
    const b = bundle()
    await b.round()
    await b.round([{ key: UPGRADER, body: upgradeMsg(app('v2'), 2) }])
    // the process died after the new file was written but before the state caught up (simulated: state says v1's code)
    const state = b.state()
    fs.writeFileSync(b.file('app.js'), app('v3-half-written'))
    fs.writeFileSync(b.file('app.prev.js'), app('v2'))
    fs.writeFileSync(b.file('upgrade.json'), JSON.stringify({ ...state, hash: sha256(app('v2')) }))
    await b.round()
    expect(b.read('app.js')).toBe(app('v2'))
    expect(b.logs.join('\n')).toMatch(/restored it from app\.prev\.js/)
  })
  it('deletes a leftover temporary file once the app matches', async () => {
    const b = bundle()
    await b.round()
    fs.writeFileSync(b.file('app.tmp.js'), 'junk')
    await b.round()
    expect(fs.existsSync(b.file('app.tmp.js'))).toBe(false)
  })
  it('does not trust a damaged upgrade.json: upgrades are off, the app still runs', async () => {
    const b = bundle()
    await b.round()
    fs.writeFileSync(b.file('upgrade.json'), '{ not json')
    const r = await b.round([{ key: UPGRADER, body: upgradeMsg(app('v2'), 2) }])
    expect(b.read('app.js')).toBe(app('v1'))
    expect(b.logs.join('\n')).toMatch(/upgrade\.json cannot be trusted/)
    expect(r.sent(UPGRADER)[0]).toMatchObject({ app: 'v1' })
  })
})

describe('reads', () => {
  it('answers a code read itself, without running the app', async () => {
    const b = bundle()
    await b.round()
    const r = await b.round([{ key: STRANGER, body: '{"type":"code","id":"q"}' }], { readonly: true })
    expect(r.sent(STRANGER)).toEqual([
      {
        type: 'code',
        id: 'q',
        node: 'edNODE',
        version: 1,
        hash: sha256(app('v1')),
        appHash: sha256(app('v1')),
        prevHash: null,
        upgraders: [UPGRADER],
        history: [{ version: 1, what: 'start', hash: sha256(app('v1')), at: NOW + 1000 }],
        last: null,
        loaded: 'app',
        error: null,
      },
    ])
    expect(b.ran()).toEqual(['v1'])
  })
  it('leaves every other read to the app', async () => {
    const b = bundle()
    await b.round()
    const r = await b.round([{ key: STRANGER, body: '{"type":"status"}' }], { readonly: true })
    expect(r.sent(STRANGER)).toEqual([{ app: 'v1', saw: '{"type":"status"}' }])
  })
  it('does not read a big first input to look for a code read', async () => {
    const b = bundle([UPGRADER], counting('v1'))
    await b.round()
    const r = await b.round([{ key: STRANGER, body: Buffer.from('{"type":"code","pad":"' + 'x'.repeat(5000) + '"}') }], { readonly: true })
    expect(r.reads).toHaveLength(0)
    expect(b.ran()).toEqual(['v1 0', 'v1 1'])
  })
})

describe('the entry point', () => {
  it('hands HotPocket an async function, because the library does not wait for anything else', () => {
    // hotpocket-nodejs-contract awaits a callback only when callback.constructor.name === 'AsyncFunction'. A plain arrow
    // returning a promise ends the round with the loader's work still in flight (the process kills itself first).
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'loader.ts'), 'utf8')
    expect(source).toMatch(/async function round\(ctx: HpContext\)/)
    expect(source).toMatch(/hpc\.init\(round, undefined, true\)/)
    expect(source).not.toMatch(/hpc\.init\(\(ctx\)/)
  })
})
