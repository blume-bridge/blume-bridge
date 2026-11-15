import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PKG, SECRET_MARKERS, cleanupTmp, makeVolume, run, tmpDir, writeForbiddenStubs } from './ops-helpers'

afterAll(cleanupTmp)

const SCRIPT = path.join(PKG, 'scripts/state-backup.sh')
const haveJq = run('jq', ['--version']).status === 0
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

interface World {
  root: string
  volRoot: string
  state: string
  seed: string
  target: string
  marker: string
  stage: string
}
function world(opts: { cursor?: number } = {}): World {
  const root = tmpDir()
  const vol = makeVolume(root, 'main', { nodes: 3, keys: [1, 2, 3] })
  const seed = vol.seedDir(1)
  const state = path.join(seed, 'state')
  fs.writeFileSync(path.join(state, 'cursor.json'), JSON.stringify({ xrpl: { ledger: opts.cursor ?? 1234, seen: ['A'] }, evm: { block: 77, seen: [] } }))
  fs.writeFileSync(path.join(state, 'transfers.json'), JSON.stringify({ t1: { id: 't1', done: true } }))
  fs.writeFileSync(path.join(state, 'operators.json'), JSON.stringify({ ed01: { node: 'ed01', xrplAddress: 'rNode1' } }))
  const target = path.join(root, 'offsite')
  const marker = path.join(root, 'marker')
  const stage = path.join(root, 'stage')
  fs.mkdirSync(stage)
  return { root, volRoot: vol.volRoot, state, seed, target, marker, stage }
}
const env = (w: World, extra: Record<string, string | undefined> = {}) => ({ CLUSTER: 'main', VOL_ROOT: w.volRoot, BACKUP_TARGET: w.target, MARKER_DIR: w.marker, STAGE_ROOT: w.stage, ...extra })
const generations = (w: World, prefix = 'state-main-node1-') => (fs.existsSync(w.target) ? fs.readdirSync(w.target).filter((f) => f.startsWith(prefix)).sort() : [])

describe.skipIf(!haveJq)('state-backup.sh', () => {
  it('writes one generation with every state file, a manifest and nothing else', () => {
    const w = world()
    const r = run('bash', [SCRIPT], { env: env(w, { BACKUP_STAMP: '20261009T120000Z' }) })
    expect(r.status, r.out).toBe(0)
    expect(generations(w)).toEqual(['state-main-node1-20261009T120000Z-1234'])
    const gen = path.join(w.target, 'state-main-node1-20261009T120000Z-1234')
    expect(fs.readdirSync(gen).sort()).toEqual(['MANIFEST.json', 'config.json', 'cursor.json', 'operators.json', 'tokens.json', 'transfers.json'])
    for (const f of ['config.json', 'cursor.json', 'operators.json', 'tokens.json', 'transfers.json']) expect(sha(path.join(gen, f))).toBe(sha(path.join(w.state, f)))
    const manifest = JSON.parse(fs.readFileSync(path.join(gen, 'MANIFEST.json'), 'utf8'))
    expect(manifest).toMatchObject({ format: 'blume-bridge-state/1', cluster: 'main', node: 1, xrplCursor: 1234, evmCursor: 77 })
    expect(Object.keys(manifest.files).sort()).toEqual(['config.json', 'cursor.json', 'operators.json', 'tokens.json', 'transfers.json'])
    expect(manifest.files['transfers.json']).toBe(sha(path.join(w.state, 'transfers.json')))
    expect(r.out).toMatch(/state backup ok: state-main-node1-20261009T120000Z-1234 \(5 files, .*xrpl cursor 1234, evm 77\) -> .*offsite; 1 generation\(s\) there \(keeping 48\)/)
    // no partial left, and the keys one level up were never read
    expect(fs.readdirSync(w.target).some((f) => f.endsWith('.partial'))).toBe(false)
    for (const marker of SECRET_MARKERS) expect(execGrep(w.target, marker)).toBe(false)
    expect(fs.readdirSync(w.stage)).toEqual([])
  })

  it('writes what snapshot-state.ts can restore from: a generation passes its own manifest check', () => {
    const w = world()
    expect(run('bash', [SCRIPT], { env: env(w, { BACKUP_STAMP: '20261009T120000Z' }) }).status).toBe(0)
    const gen = path.join(w.target, 'state-main-node1-20261009T120000Z-1234')
    const out = path.join(w.root, 'snapshot.json')
    const r = run('npx', ['--no-install', 'tsx', path.join(PKG, 'scripts/snapshot-state.ts')], { env: { STATE_FROM: gen, SNAPSHOT_OUT: out } })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/every file matches its manifest/)
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).cursor.xrpl.ledger).toBe(1234)
    // and a generation that was touched afterwards does not
    fs.writeFileSync(path.join(gen, 'tokens.json'), '{"PETAL":{}}')
    expect(run('npx', ['--no-install', 'tsx', path.join(PKG, 'scripts/snapshot-state.ts')], { env: { STATE_FROM: gen, SNAPSHOT_OUT: out } }).out).toMatch(/tokens\.json does not match its recorded hash/)
  })

  it('refuses a directory that holds files named like keys, and copies nothing', () => {
    const w = world()
    const r = run('bash', [SCRIPT], { env: env(w, { STATE_DIR: w.seed }) })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/holds files named like keys: bridge-keys\.json/)
    expect(fs.existsSync(w.target)).toBe(false)
    fs.writeFileSync(path.join(w.state, 'wallet-seed.json'), '{}')
    const again = run('bash', [SCRIPT], { env: env(w) })
    expect(again.status).toBe(1)
    expect(again.out).toMatch(/wallet-seed\.json/)
  })

  it('refuses a state that is not JSON, or not a state directory', () => {
    const w = world()
    fs.writeFileSync(path.join(w.state, 'transfers.json'), '{"torn":')
    const r = run('bash', [SCRIPT], { env: env(w) })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/transfers\.json is not valid JSON/)
    expect(fs.existsSync(w.target)).toBe(false)
    const empty = path.join(w.root, 'empty')
    fs.mkdirSync(empty)
    expect(run('bash', [SCRIPT], { env: env(w, { STATE_DIR: empty }) }).out).toMatch(/not a bridge state directory/)
    expect(run('bash', [SCRIPT], { env: env(w, { STATE_DIR: path.join(w.root, 'nowhere') }) }).out).toMatch(/no state directory/)
  })

  it('keeps the newest N generations of this cluster and node, and leaves everything else alone', () => {
    const w = world()
    fs.mkdirSync(w.target)
    fs.mkdirSync(path.join(w.target, 'state-other-node1-20250101T000000Z-1'))
    fs.mkdirSync(path.join(w.target, 'state-main-node2-20250101T000000Z-1'))
    fs.writeFileSync(path.join(w.target, 'notes.txt'), 'mine')
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(w.state, 'cursor.json'), JSON.stringify({ xrpl: { ledger: 2000 + i, seen: [] } }))
      const r = run('bash', [SCRIPT], { env: env(w, { KEEP: '3', BACKUP_STAMP: `20261009T12000${i}Z` }) })
      expect(r.status, r.out).toBe(0)
    }
    expect(generations(w)).toEqual(['state-main-node1-20261009T120002Z-2002', 'state-main-node1-20261009T120003Z-2003', 'state-main-node1-20261009T120004Z-2004'])
    expect(fs.existsSync(path.join(w.target, 'state-other-node1-20250101T000000Z-1'))).toBe(true)
    expect(fs.existsSync(path.join(w.target, 'state-main-node2-20250101T000000Z-1'))).toBe(true)
    expect(fs.readFileSync(path.join(w.target, 'notes.txt'), 'utf8')).toBe('mine')
  })

  it('PRUNE=0 only adds', () => {
    const w = world()
    for (let i = 0; i < 3; i++) expect(run('bash', [SCRIPT], { env: env(w, { KEEP: '1', PRUNE: '0', BACKUP_STAMP: `20261009T12000${i}Z` }) }).status).toBe(0)
    expect(generations(w)).toHaveLength(3)
  })

  it('works for any node number and cluster', () => {
    const w = world()
    // node 2's state is the same cluster's state, copied from another directory
    const r = run('bash', [SCRIPT], { env: env(w, { NODE_NUMBER: '2', BACKUP_STAMP: '20261009T130000Z' }) })
    expect(r.status, r.out).toBe(0)
    expect(generations(w, 'state-main-node2-')).toEqual(['state-main-node2-20261009T130000Z-1002'])
  })

  it('never overwrites a generation of the same name', () => {
    const w = world()
    expect(run('bash', [SCRIPT], { env: env(w, { BACKUP_STAMP: '20261009T120000Z' }) }).status).toBe(0)
    const again = run('bash', [SCRIPT], { env: env(w, { BACKUP_STAMP: '20261009T120000Z' }) })
    expect(again.status).toBe(1)
    expect(again.out).toMatch(/already exists/)
  })

  it('warns when the cursor has not moved for several copies in a row', () => {
    const w = world()
    const outs = [0, 1, 2, 3].map((i) => run('bash', [SCRIPT], { env: env(w, { BACKUP_STAMP: `20261009T12000${i}Z` }) }))
    expect(outs.every((o) => o.status === 0)).toBe(true)
    expect(outs[0].stderr).toBe('')
    expect(outs[2].stderr).toBe('')
    expect(outs[3].stderr).toMatch(/cursor has not moved in 3 copies in a row \(1234\)/)
    // it moves: the count restarts
    fs.writeFileSync(path.join(w.state, 'cursor.json'), JSON.stringify({ xrpl: { ledger: 1300, seen: [] } }))
    expect(run('bash', [SCRIPT], { env: env(w, { BACKUP_STAMP: '20261009T120009Z' }) }).stderr).toBe('')
  })

  it('takes a consistent copy while the node is writing: all files from the same moment', async () => {
    const w = world()
    let version = 0
    let writing = true
    // every file carries the version, rewritten together every 60 ms for a second and a half
    const writer = setInterval(() => {
      if (!writing) return
      version++
      for (const f of ['tokens.json', 'transfers.json']) fs.writeFileSync(path.join(w.state, f), JSON.stringify({ version }))
    }, 60)
    setTimeout(() => (writing = false), 1500)
    const child = spawn('bash', [SCRIPT], { env: { ...process.env, ...env(w, { BACKUP_STAMP: '20261009T140000Z' }) }, cwd: PKG })
    const code: number = await new Promise((resolve) => child.on('close', resolve))
    clearInterval(writer)
    expect(code).toBe(0)
    const gen = path.join(w.target, 'state-main-node1-20261009T140000Z-1234')
    const tokens = JSON.parse(fs.readFileSync(path.join(gen, 'tokens.json'), 'utf8'))
    const transfers = JSON.parse(fs.readFileSync(path.join(gen, 'transfers.json'), 'utf8'))
    expect(tokens.version).toBeGreaterThan(0)
    expect(tokens.version).toBe(transfers.version)
  }, 30_000)

  it('validates the target and the options before touching anything', () => {
    const w = world()
    const bad = (extra: Record<string, string | undefined>, re: RegExp) => {
      const r = run('bash', [SCRIPT], { env: env(w, extra) })
      expect(r.status, JSON.stringify(extra)).toBe(1)
      expect(r.out).toMatch(re)
    }
    bad({ BACKUP_TARGET: undefined }, /BACKUP_TARGET is required/)
    bad({ BACKUP_TARGET: 'relative/dir' }, /must be user@host:\/absolute\/path/)
    bad({ BACKUP_TARGET: 'user@host:relative' }, /must be user@host/)
    bad({ BACKUP_TARGET: 'user@host:/a b' }, /must be user@host/)
    bad({ BACKUP_TARGET: 'user@host:/a;rm -rf /' }, /must be user@host/)
    bad({ BACKUP_TARGET: '/' }, /names the root directory/)
    bad({ KEEP: '0' }, /KEEP/)
    bad({ KEEP: 'many' }, /KEEP/)
    bad({ PRUNE: '2' }, /PRUNE/)
    bad({ NODE_NUMBER: '0' }, /NODE_NUMBER/)
    bad({ CLUSTER: '../x' }, /bad CLUSTER/)
    bad({ SSH_OPTS: '-o ProxyCommand=$(reboot)' }, /SSH_OPTS/)
    bad({ BACKUP_METHOD: 'ftp' }, /BACKUP_METHOD/)
  })

  it('DRY_RUN prints the rsync, the rename and the prune for a remote target and runs none of them', () => {
    const w = world()
    const bin = path.join(w.root, 'bin')
    fs.mkdirSync(bin)
    writeForbiddenStubs(bin, ['ssh', 'rsync', 'scp'])
    const log = path.join(w.root, 'forbidden.log')
    const r = run('bash', [SCRIPT], { env: env(w, { BACKUP_TARGET: 'backup@vault.example:/srv/bridge-state/', DRY_RUN: '1', KEEP: '24', SSH_OPTS: '-i /root/.ssh/state-backup -o StrictHostKeyChecking=yes', BACKUP_METHOD: 'rsync', BACKUP_STAMP: '20261009T150000Z', PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log }) })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('DRY_RUN=1')
    expect(r.out).toContain('source: ')
    expect(r.out).toContain("+ rsync -a -e 'ssh -i /root/.ssh/state-backup -o StrictHostKeyChecking=yes' <stage>/ backup@vault.example:/srv/bridge-state/state-main-node1-20261009T150000Z-1234.partial/")
    expect(r.out).toContain("mv /srv/bridge-state/state-main-node1-20261009T150000Z-1234.partial /srv/bridge-state/state-main-node1-20261009T150000Z-1234")
    expect(r.out).toContain('tail -n +25')
    expect(fs.existsSync(log)).toBe(false)
    const scp = run('bash', [SCRIPT], { env: env(w, { BACKUP_TARGET: 'backup@vault.example:/srv/bridge-state', DRY_RUN: '1', BACKUP_METHOD: 'scp', PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log }) })
    expect(scp.out).toMatch(/\+ scp -r .*backup@vault\.example:\/srv\/bridge-state\/state-main-node1-.*\.partial/)
    const noPrune = run('bash', [SCRIPT], { env: env(w, { BACKUP_TARGET: 'backup@vault.example:/srv/bridge-state', DRY_RUN: '1', PRUNE: '0', PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log }) })
    expect(noPrune.out).not.toContain('tail -n')
    expect(fs.existsSync(log)).toBe(false)
    expect(fs.existsSync(w.target)).toBe(false)
  })

  it('DRY_RUN for a local target copies nothing', () => {
    const w = world()
    const r = run('bash', [SCRIPT], { env: env(w, { DRY_RUN: '1' }) })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/\+ copy <stage> to .*offsite\/state-main-node1-.*\.partial/)
    expect(fs.existsSync(w.target)).toBe(false)
  })
})

/** Does any file under the directory contain this text? */
function execGrep(dir: string, text: string): boolean {
  const walk = (d: string): boolean => fs.readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : fs.readFileSync(path.join(d, e.name), 'utf8').includes(text)))
  return walk(dir)
}
