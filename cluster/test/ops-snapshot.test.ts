import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { chooseSnapshot, digestOf, expectedNodes, minAgreeFrom, nodeNumbers, verifyManifest } from '../scripts/snapshot-plan'
import { DEV_PARAMS, PKG, cleanupTmp, run, tmpDir } from './ops-helpers'

afterAll(cleanupTmp)

describe('snapshot plan: which nodes, how many, whose state', () => {
  it('digests names and exact bytes', () => {
    const a = digestOf({ 'a.json': '{}', 'b.json': '[]' })
    expect(digestOf({ 'b.json': '[]', 'a.json': '{}' })).toBe(a)
    expect(digestOf({ 'a.json': '{}', 'b.json': '[ ]' })).not.toBe(a)
    expect(digestOf({ 'a.json': '{}' })).not.toBe(a)
    expect(digestOf({ 'a.json': Buffer.from('{}'), 'b.json': Buffer.from('[]') })).toBe(a)
  })

  it('finds node directories by name, whatever their number', () => {
    expect(nodeNumbers(['node3', 'node1', 'node10', 'node2', 'node1.bak', 'nodeX', 'node', 'other', 'node0'])).toEqual([1, 2, 3, 10])
  })

  it('takes the node count from CLUSTER_SIZE or the directories, and they must match exactly', () => {
    const five = ['node1', 'node2', 'node3', 'node4', 'node5']
    expect(expectedNodes(five, undefined)).toEqual([1, 2, 3, 4, 5])
    expect(expectedNodes(five, '5')).toEqual([1, 2, 3, 4, 5])
    expect(() => expectedNodes(five, '3')).toThrow(/node 4, 5 was pulled as well/)
    expect(() => expectedNodes(['node1', 'node2', 'node3'], '5')).toThrow(/node 4, 5 was not pulled/)
    expect(() => expectedNodes(['node1', 'node3'], undefined)).toThrow(/node 2 was not pulled/)
    expect(() => expectedNodes([], undefined)).toThrow(/no node directories/)
    expect(() => expectedNodes(five, 'five')).toThrow(/CLUSTER_SIZE/)
    expect(() => expectedNodes(five, '0')).toThrow(/CLUSTER_SIZE/)
  })

  it('SNAPSHOT_MIN_AGREE defaults to every node and never goes below k', () => {
    expect(minAgreeFrom(undefined, 5, 3)).toBe(5)
    expect(minAgreeFrom('', 5, 3)).toBe(5)
    expect(minAgreeFrom('4', 5, 3)).toBe(4)
    expect(minAgreeFrom('3', 5, 3)).toBe(3)
    expect(() => minAgreeFrom('2', 5, 3)).toThrow(/below k=3/)
    expect(() => minAgreeFrom('6', 5, 3)).toThrow(/only 5 node/)
    expect(() => minAgreeFrom('x', 5, 3)).toThrow(/positive integer/)
  })

  it('takes the state every node agrees on', () => {
    const nodes = [1, 2, 3, 4, 5].map((n) => ({ n, digest: 'same' }))
    expect(chooseSnapshot(nodes, 5)).toEqual({ chosen: [1, 2, 3, 4, 5], dissent: [], digest: 'same' })
  })

  it('refuses a split cluster by default and names the groups', () => {
    const nodes = [1, 2, 3, 4, 5].map((n) => ({ n, digest: n === 5 ? 'other' : 'same' }))
    expect(() => chooseSnapshot(nodes, 5)).toThrow(/node 1\+2\+3\+4 vs node 5\); not writing a snapshot from a split cluster.*SNAPSHOT_MIN_AGREE/)
  })

  it('takes the majority when told how many must agree, and names the dissenters', () => {
    const nodes = [1, 2, 3, 4, 5].map((n) => ({ n, digest: n === 5 ? 'other' : 'same' }))
    expect(chooseSnapshot(nodes, 4)).toEqual({ chosen: [1, 2, 3, 4], dissent: [5], digest: 'same' })
    expect(() => chooseSnapshot(nodes, 5)).toThrow()
  })

  it('refuses when the biggest group is smaller than required, or when two groups tie', () => {
    const split = [1, 2, 3, 4, 5].map((n) => ({ n, digest: n <= 3 ? 'a' : n === 4 ? 'b' : 'c' }))
    expect(() => chooseSnapshot(split, 4)).toThrow(/only 3 node\(s\) agree/)
    const tie = [1, 2, 3, 4].map((n) => ({ n, digest: n <= 2 ? 'a' : 'b' }))
    expect(() => chooseSnapshot(tie, 2)).toThrow(/two groups of 2/)
  })

  it('a one-node cluster is its own majority', () => {
    expect(chooseSnapshot([{ n: 1, digest: 'x' }], 1)).toMatchObject({ chosen: [1], dissent: [] })
  })
})

describe('snapshot-state.ts end to end on a pulled stage', () => {
  const SCRIPT = path.join(PKG, 'scripts/snapshot-state.ts')
  const config = (n: number, k: number) => ({ k, n, feed: 'fake', params: DEV_PARAMS, xrpl: { rpc: ['https://testnet.xrpl-labs.com/'], lockAccount: 'rLock', fundingAccount: 'rFund', windowLedgers: 5, maxEventsPerView: 50, pollMs: 1000 }, intentTtlMs: 1 })

  function stage(opts: { nodes: number; n?: number; k?: number; tweak?: (node: number, dir: string) => void }) {
    const root = tmpDir()
    const dir = path.join(root, 'stage')
    for (let i = 1; i <= opts.nodes; i++) {
      const state = path.join(dir, `node${i}`, 'contract_fs', 'seed', 'state')
      fs.mkdirSync(state, { recursive: true })
      fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(config(opts.n ?? opts.nodes, opts.k ?? 3)))
      fs.writeFileSync(path.join(state, 'cursor.json'), JSON.stringify({ xrpl: { ledger: 4242, seen: ['A'] }, evm: { block: 77, seen: [] } }))
      fs.writeFileSync(path.join(state, 'tokens.json'), JSON.stringify({ PETAL: { sym: 'PETAL', lockedUnits: '12' } }))
      fs.writeFileSync(path.join(state, 'transfers.json'), JSON.stringify({ t1: { id: 't1' } }))
      opts.tweak?.(i, state)
    }
    return { root, dir, out: path.join(root, 'snapshot.json') }
  }
  const snap = (s: ReturnType<typeof stage>, env: Record<string, string> = {}) => run('npx', ['--no-install', 'tsx', SCRIPT, s.dir], { env: { SNAPSHOT_OUT: s.out, CLUSTER_SIZE: undefined as unknown as string, ...env } })

  it('writes the cluster state of five agreeing nodes', () => {
    const s = stage({ nodes: 5 })
    const r = snap(s)
    expect(r.status, r.out).toBe(0)
    const doc = JSON.parse(fs.readFileSync(s.out, 'utf8'))
    expect(doc.config.n).toBe(5)
    expect(doc.cursor.xrpl.ledger).toBe(4242)
    expect(doc.tokens.PETAL.lockedUnits).toBe('12')
    expect(doc.transfers.t1.id).toBe('t1')
    expect(r.out).toMatch(/node 5: state/)
    expect(r.out).toMatch(/n=5 k=3/)
  })

  it('refuses a node count the state does not agree with', () => {
    const s = stage({ nodes: 5, n: 3, k: 2 })
    const r = snap(s)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/the state says n=3 but 5 node\(s\) were pulled/)
    expect(fs.existsSync(s.out)).toBe(false)
    const sized = snap(stage({ nodes: 5 }), { CLUSTER_SIZE: '3' })
    expect(sized.status).toBe(1)
    expect(sized.out).toMatch(/was pulled as well/)
  })

  it('refuses a split cluster, and takes the majority when allowed', () => {
    const tweak = (node: number, dir: string) => {
      if (node === 5) fs.writeFileSync(path.join(dir, 'transfers.json'), JSON.stringify({ t1: { id: 't1' }, t2: { id: 'late' } }))
    }
    const s = stage({ nodes: 5, tweak })
    const refused = snap(s)
    expect(refused.status).toBe(1)
    expect(refused.out).toMatch(/split cluster/)
    expect(fs.existsSync(s.out)).toBe(false)
    const allowed = snap(s, { SNAPSHOT_MIN_AGREE: '4' })
    expect(allowed.status, allowed.out).toBe(0)
    expect(allowed.out).toMatch(/node 5 hold different state/)
    expect(Object.keys(JSON.parse(fs.readFileSync(s.out, 'utf8')).transfers)).toEqual(['t1'])
    expect(snap(s, { SNAPSHOT_MIN_AGREE: '2' }).out).toMatch(/below k=3/)
  })

  it('swaps the config in only when it keeps the same operators', () => {
    const s = stage({ nodes: 5 })
    const same = path.join(s.root, 'same.json')
    fs.writeFileSync(same, JSON.stringify({ config: { ...config(5, 3), intentTtlMs: 999 } }))
    const ok = snap(s, { CONFIG_FROM: same })
    expect(ok.status, ok.out).toBe(0)
    expect(JSON.parse(fs.readFileSync(s.out, 'utf8')).config.intentTtlMs).toBe(999)

    const widened = path.join(s.root, 'widened.json')
    fs.writeFileSync(widened, JSON.stringify({ config: config(7, 4) }))
    const refused = snap(s, { CONFIG_FROM: widened })
    expect(refused.status).toBe(1)
    expect(refused.out).toMatch(/membership change/)

    const elsewhere = path.join(s.root, 'elsewhere.json')
    fs.writeFileSync(elsewhere, JSON.stringify({ config: { ...config(5, 3), xrpl: { ...config(5, 3).xrpl, lockAccount: 'rOther' } } }))
    expect(snap(s, { CONFIG_FROM: elsewhere }).out).toMatch(/names different accounts/)
  })

  it('says so when a node never ran the bundle', () => {
    const s = stage({ nodes: 3, tweak: (node, dir) => node === 2 && fs.rmSync(path.join(dir, 'config.json')) })
    const r = snap(s)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/no config\.json/)
  })

  it('CLEAR_OPERATORS=1 empties the operator set of a snapshot taken from a live cluster too', () => {
    const s = stage({ nodes: 5, tweak: (_node, dir) => fs.writeFileSync(path.join(dir, 'operators.json'), JSON.stringify({ ed01: { node: 'ed01', xrplAddress: 'rN1', xrplPublicKey: 'p', evmAddress: '0x1' } })) })
    expect(Object.keys(JSON.parse((snap(s), fs.readFileSync(s.out, 'utf8'))).operators)).toEqual(['ed01'])
    const r = snap(s, { CLEAR_OPERATORS: '1' })
    expect(r.status, r.out).toBe(0)
    expect(JSON.parse(fs.readFileSync(s.out, 'utf8')).operators).toEqual({})
  })
})

describe('verifyManifest', () => {
  const files = { 'a.json': Buffer.from('{"a":1}'), 'b.json': Buffer.from('[]') }
  const manifest = { files: { 'a.json': createHash('sha256').update(files['a.json']).digest('hex'), 'b.json': createHash('sha256').update(files['b.json']).digest('hex') } }
  it('accepts a copy that matches, MANIFEST.json itself aside', () => {
    expect(verifyManifest(files, manifest)).toEqual([])
    expect(verifyManifest({ ...files, 'MANIFEST.json': Buffer.from('{}') }, manifest)).toEqual([])
  })
  it('names a file that changed, one that went missing and one the manifest does not know', () => {
    expect(verifyManifest({ ...files, 'a.json': Buffer.from('{"a":2}') }, manifest)).toEqual(['a.json does not match its recorded hash'])
    expect(verifyManifest({ 'a.json': files['a.json'] }, manifest)).toEqual(['b.json is in the manifest but not in the copy'])
    expect(verifyManifest({ ...files, 'c.json': Buffer.from('1') }, manifest)).toEqual(['c.json is in the copy but not in the manifest'])
  })
  it('refuses a manifest that lists nothing', () => {
    expect(verifyManifest(files, {})).toEqual(['the manifest lists no files'])
    expect(verifyManifest(files, null)).toEqual(['the manifest lists no files'])
    expect(verifyManifest(files, { files: {} })).toEqual(['the manifest lists no files'])
  })
})

describe('snapshot-state.ts from a backup copy (the way back from a lost box)', () => {
  const SCRIPT = path.join(PKG, 'scripts/snapshot-state.ts')
  const config = { k: 3, n: 5, feed: 'fake', params: DEV_PARAMS, xrpl: { rpc: ['https://testnet.xrpl-labs.com/'], lockAccount: 'rLock', fundingAccount: 'rFund', windowLedgers: 5, maxEventsPerView: 50, pollMs: 1000 }, intentTtlMs: 1 }

  /** A generation the way state-backup.sh writes one: the state files and a manifest of their hashes. */
  function generation(over: { skipManifest?: boolean; tamper?: boolean } = {}) {
    const root = tmpDir()
    const dir = path.join(root, 'state-main-node1-20261009T120000Z-4242')
    fs.mkdirSync(dir)
    const state: Record<string, unknown> = {
      'config.json': config,
      'cursor.json': { xrpl: { ledger: 4242, seen: ['A'] }, evm: { block: 77, seen: ['0xabc:1'] } },
      'tokens.json': { PETAL: { sym: 'PETAL', lockedUnits: '12' } },
      'transfers.json': { t1: { id: 't1' } },
      'operators.json': { ed01: { node: 'ed01', xrplAddress: 'rN1', xrplPublicKey: 'p', evmAddress: '0x1' } },
    }
    const hashes: Record<string, string> = {}
    for (const [name, doc] of Object.entries(state)) {
      const text = JSON.stringify(doc)
      fs.writeFileSync(path.join(dir, name), text)
      hashes[name] = createHash('sha256').update(text).digest('hex')
    }
    if (!over.skipManifest) fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify({ format: 'blume-bridge-state/1', createdAt: '2026-10-09T12:00:00Z', cluster: 'main', node: 1, xrplCursor: 4242, files: hashes }))
    if (over.tamper) fs.writeFileSync(path.join(dir, 'transfers.json'), JSON.stringify({ t1: { id: 't1' }, t2: { id: 'added' } }))
    return { root, dir, out: path.join(root, 'snapshot.json') }
  }
  const snap = (g: ReturnType<typeof generation>, env: Record<string, string> = {}, args: string[] = []) => run('npx', ['--no-install', 'tsx', SCRIPT, ...args], { env: { SNAPSHOT_OUT: g.out, STATE_FROM: g.dir, CLUSTER_SIZE: undefined as unknown as string, ...env } })

  it('builds the snapshot from the copy and says it is older than the cluster was', () => {
    const g = generation()
    const r = snap(g)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/state from the backup copy state-main-node1-20261009T120000Z-4242: taken 2026-10-09T12:00:00Z, cursor 4242 evm 77; every file matches its manifest/)
    expect(r.out).toMatch(/Run scripts\/reconcile-snapshot\.ts/)
    const doc = JSON.parse(fs.readFileSync(g.out, 'utf8'))
    expect(doc.cursor).toEqual({ xrpl: { ledger: 4242, seen: ['A'] }, evm: { block: 77, seen: ['0xabc:1'] } })
    expect(doc.tokens.PETAL.lockedUnits).toBe('12')
    expect(Object.keys(doc.operators)).toEqual(['ed01'])
  })

  it('CLEAR_OPERATORS=1 empties the operator set so a new cluster votes its keys', () => {
    const g = generation()
    const r = snap(g, { CLEAR_OPERATORS: '1' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/operator set cleared/)
    expect(JSON.parse(fs.readFileSync(g.out, 'utf8')).operators).toEqual({})
    expect(snap(generation(), { CLEAR_OPERATORS: 'yes' }).out).toMatch(/CLEAR_OPERATORS must be 1/)
  })

  it('refuses a copy that does not match its manifest, has none, or is mixed up with a stage', () => {
    const tampered = generation({ tamper: true })
    const r = snap(tampered)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/does not match its manifest[\s\S]*transfers\.json does not match its recorded hash/)
    expect(fs.existsSync(tampered.out)).toBe(false)
    expect(snap(generation({ skipManifest: true })).out).toMatch(/has no MANIFEST\.json/)
    expect(snap(generation(), {}, ['.snapshot']).out).toMatch(/either a stage dir or STATE_FROM/)
  })

  it('swaps the config in a restored copy the same way, keeping the operators', () => {
    const g = generation()
    const from = path.join(g.root, 'new.json')
    fs.writeFileSync(from, JSON.stringify({ config: { ...config, intentTtlMs: 555 } }))
    const r = snap(g, { CONFIG_FROM: from })
    expect(r.status, r.out).toBe(0)
    expect(JSON.parse(fs.readFileSync(g.out, 'utf8')).config.intentTtlMs).toBe(555)
  })
})
