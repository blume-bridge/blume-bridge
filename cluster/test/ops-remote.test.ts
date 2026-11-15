import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PKG, SECRET_MARKERS, cleanupTmp, dummyKeys, makeVolume, run, tmpDir, writeDockerStub } from './ops-helpers'

/**
 * The remote halves of deploy-dev.sh, snapshot-state.sh and hpdevkit-cluster.sh, run against a fake hpdevkit volume
 * in a temp directory with a docker double. They never see a host: this is the whole point of keeping the logic that
 * can lose keys in files of its own.
 */
afterAll(cleanupTmp)

const REDEPLOY = path.join(PKG, 'scripts/remote/redeploy.sh')
const SNAPSHOT = path.join(PKG, 'scripts/remote/snapshot-pull.sh')
const MANAGE = path.join(PKG, 'scripts/remote/cluster-manage.sh')
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

interface World {
  root: string
  nodes: number
  cluster: string
  vol: ReturnType<typeof makeVolume>
  remoteDir: string
  shm: string
  docker: string
  log: string
  upper: string
}

function world(opts: { nodes: number; keys?: number[]; payout?: number[]; cluster?: string; config?: Record<string, unknown> }): World {
  const root = tmpDir()
  const cluster = opts.cluster ?? 'main'
  const vol = makeVolume(root, cluster, { nodes: opts.nodes, keys: opts.keys ?? [], payout: opts.payout, config: opts.config })
  const remoteDir = path.join(root, `bridge-cluster-${cluster}`)
  fs.mkdirSync(path.join(remoteDir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(remoteDir, 'dist', 'index.js'), '// bundle')
  fs.writeFileSync(path.join(remoteDir, 'dist', 'genesis.json'), JSON.stringify({ config: opts.config ?? { k: 2, n: opts.nodes, xrpl: { rpc: [] } } }))
  const shm = path.join(root, 'shm')
  fs.mkdirSync(shm)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const docker = writeDockerStub(bin)
  const upper = path.join(root, 'upper')
  for (let n = 1; n <= opts.nodes; n++) {
    fs.mkdirSync(path.join(upper, `hpdevkit_${cluster}_node_${n}`, 'tmp'), { recursive: true })
    fs.writeFileSync(path.join(upper, `hpdevkit_${cluster}_node_${n}`, 'tmp', 'bridge-cluster.log'), 'old log')
    fs.writeFileSync(path.join(upper, `hpdevkit_${cluster}_node_${n}`, 'tmp', 'other.txt'), 'not ours')
  }
  return { root, nodes: opts.nodes, cluster, vol, remoteDir, shm, docker, log: path.join(root, 'docker.log'), upper }
}

function envFor(w: World, extra: Record<string, string> = {}): Record<string, string> {
  return {
    CLUSTER: w.cluster,
    REMOTE_DIR: w.remoteDir,
    NODES: String(w.nodes),
    MAINNET: '0',
    ACCEPT_NEW_KEYS: '',
    STAGE_ROOT: w.shm,
    VOL_ROOT: w.vol.volRoot,
    DOCKER: w.docker,
    STOP_WAIT_S: '1',
    START_WAIT_S: '0',
    STUB_LOG: w.log,
    STUB_VOL: w.vol.vol,
    STUB_UPPER: w.upper,
    STUB_VOLROOT: w.vol.volRoot,
    ...extra,
  }
}

const dockerCalls = (w: World): string[] => (fs.existsSync(w.log) ? fs.readFileSync(w.log, 'utf8').split('\n').filter(Boolean) : [])
const sawCall = (w: World, needle: string) => dockerCalls(w).some((c) => c.includes(needle))
const modeOf = (p: string) => fs.statSync(p).mode & 0o777
const noSecretsIn = (out: string) => {
  for (const m of SECRET_MARKERS) expect(out).not.toContain(m)
}

describe('redeploy.sh: keys cross the wipe, for any n', () => {
  it('keeps all five nodes keys and the payout files that exist (the 3-node assumption wiped nodes 4 and 5)', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 4, 5], payout: [2, 5] })
    const r = run('bash', [REDEPLOY], { env: envFor(w) })
    expect(r.status, r.out).toBe(0)
    for (let n = 1; n <= 5; n++) {
      const file = path.join(w.vol.seedDir(n), 'bridge-keys.json')
      expect(JSON.parse(fs.readFileSync(file, 'utf8')), `node ${n}`).toEqual(dummyKeys(n))
      expect(modeOf(file)).toBe(0o600)
    }
    for (const n of [2, 5]) expect(JSON.parse(fs.readFileSync(path.join(w.vol.seedDir(n), 'bridge-payout.json'), 'utf8'))).toEqual({ address: `rPayout${n}Address` })
    for (const n of [1, 3, 4]) expect(fs.existsSync(path.join(w.vol.seedDir(n), 'bridge-payout.json'))).toBe(false)
    // the staged copies are gone
    expect(fs.readdirSync(w.shm)).toEqual([])
    // stop, then sync, then start, in that order; the new bundle landed in the volume
    const calls = dockerCalls(w).filter((c) => c.startsWith('exec') && c.includes(' cluster '))
    expect(calls.map((c) => c.split(' ').slice(2).join(' '))).toEqual(['cluster stop', 'cluster sync', 'cluster start'])
    expect(fs.existsSync(path.join(w.vol.vol, 'contract_bundle', 'index.js'))).toBe(true)
    // node-local caches went, other files in /tmp stayed
    for (let n = 1; n <= 5; n++) {
      expect(fs.existsSync(path.join(w.upper, `hpdevkit_main_node_${n}`, 'tmp', 'bridge-cluster.log'))).toBe(false)
      expect(fs.existsSync(path.join(w.upper, `hpdevkit_main_node_${n}`, 'tmp', 'other.txt'))).toBe(true)
    }
    noSecretsIn(r.out)
  })

  it('still works for three nodes', () => {
    const w = world({ nodes: 3, keys: [1, 2, 3], payout: [1] })
    const r = run('bash', [REDEPLOY], { env: envFor(w, { CLUSTER: w.cluster }) })
    expect(r.status, r.out).toBe(0)
    for (let n = 1; n <= 3; n++) expect(JSON.parse(fs.readFileSync(path.join(w.vol.seedDir(n), 'bridge-keys.json'), 'utf8'))).toEqual(dummyKeys(n))
    expect(fs.readdirSync(w.shm)).toEqual([])
  })

  it('stops before touching anything when one node has no key file, and says which', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 5] })
    const r = run('bash', [REDEPLOY], { env: envFor(w) })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/node 4 has no key file/)
    expect(r.out).toMatch(/ACCEPT_NEW_KEYS=4/)
    expect(sawCall(w, 'cluster stop')).toBe(false)
    expect(sawCall(w, 'cluster sync')).toBe(false)
    for (const n of [1, 2, 3, 5]) expect(fs.existsSync(path.join(w.vol.seedDir(n), 'bridge-keys.json'))).toBe(true)
    expect(fs.existsSync(path.join(w.vol.seedDir(1), 'state', 'config.json'))).toBe(true)
    expect(fs.readdirSync(w.shm)).toEqual([])
  })

  it('lets a node start without a key only when it is named, and warns', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 5] })
    const r = run('bash', [REDEPLOY], { env: envFor(w, { ACCEPT_NEW_KEYS: '4' }) })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/node\(s\) 4 will make new signing keys/)
    expect(fs.existsSync(path.join(w.vol.seedDir(4), 'bridge-keys.json'))).toBe(false)
    for (const n of [1, 2, 3, 5]) expect(JSON.parse(fs.readFileSync(path.join(w.vol.seedDir(n), 'bridge-keys.json'), 'utf8'))).toEqual(dummyKeys(n))
    // naming a different node does not cover node 4
    const w2 = world({ nodes: 5, keys: [1, 2, 3, 5] })
    const r2 = run('bash', [REDEPLOY], { env: envFor(w2, { ACCEPT_NEW_KEYS: '2,3' }) })
    expect(r2.status).toBe(1)
    expect(sawCall(w2, 'cluster stop')).toBe(false)
  })

  it('treats a cluster with no keys at all as fresh on a test network and refuses it on mainnet unless told', () => {
    const w = world({ nodes: 3, keys: [] })
    const fresh = run('bash', [REDEPLOY], { env: envFor(w) })
    expect(fresh.status, fresh.out).toBe(0)
    expect(fresh.out).toMatch(/fresh cluster/)

    const m = world({ nodes: 5, keys: [] })
    const refused = run('bash', [REDEPLOY], { env: envFor(m, { MAINNET: '1' }) })
    expect(refused.status).toBe(1)
    expect(refused.out).toMatch(/mainnet cluster/)
    expect(refused.out).toMatch(/ACCEPT_NEW_KEYS=all/)
    expect(sawCall(m, 'cluster stop')).toBe(false)

    const allowed = run('bash', [REDEPLOY], { env: envFor(m, { MAINNET: '1', ACCEPT_NEW_KEYS: 'all' }) })
    expect(allowed.status, allowed.out).toBe(0)
  })

  it('does not treat an empty key file as missing', () => {
    const w = world({ nodes: 3, keys: [1, 2, 3] })
    fs.writeFileSync(path.join(w.vol.seedDir(2), 'bridge-keys.json'), '')
    const r = run('bash', [REDEPLOY], { env: envFor(w, { ACCEPT_NEW_KEYS: 'all' }) })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/node 2: .*exists but is empty/)
    expect(sawCall(w, 'cluster stop')).toBe(false)
  })

  it('refuses when the volume holds a different number of nodes than the deploy is for', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 4, 5] })
    const r = run('bash', [REDEPLOY], { env: envFor(w, { NODES: '3' }) })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/holds 5 node directories but this deploy is for 3/)
    expect(dockerCalls(w)).toEqual([])
  })

  it('does not wipe when the nodes are still running after the stop', () => {
    const w = world({ nodes: 3, keys: [1, 2, 3] })
    const r = run('bash', [REDEPLOY], { env: envFor(w, { STUB_RUNNING: '1' }) })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/still running/)
    expect(sawCall(w, 'cluster sync')).toBe(false)
    expect(fs.readdirSync(w.shm)).toEqual([])
    for (let n = 1; n <= 3; n++) expect(fs.existsSync(path.join(w.vol.seedDir(n), 'bridge-keys.json'))).toBe(true)
  })

  it('refuses to run while an earlier deploy left keys staged, and points at the restore', () => {
    const w = world({ nodes: 3, keys: [1, 2, 3] })
    const old = path.join(w.shm, 'bridge-keys.OLD123')
    fs.mkdirSync(old, { mode: 0o700 })
    fs.writeFileSync(path.join(old, 'node1.json'), JSON.stringify(dummyKeys(1)))
    const r = run('bash', [REDEPLOY], { env: envFor(w) })
    expect(r.status).toBe(1)
    expect(r.out).toContain(old)
    expect(r.out).toMatch(/RESTORE-KEYS\.sh/)
    expect(fs.existsSync(path.join(old, 'node1.json'))).toBe(true)
    expect(sawCall(w, 'cluster stop')).toBe(false)
  })

  it('puts the keys back and still fails loudly when cluster sync fails after the wipe', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 4, 5], payout: [4] })
    const r = run('bash', [REDEPLOY], { env: envFor(w, { STUB_SYNC: 'fail' }) })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/cluster sync failed/)
    expect(r.out).toMatch(/keys are back on the nodes/)
    for (let n = 1; n <= 5; n++) expect(JSON.parse(fs.readFileSync(path.join(w.vol.seedDir(n), 'bridge-keys.json'), 'utf8'))).toEqual(dummyKeys(n))
    expect(fs.existsSync(path.join(w.vol.seedDir(4), 'bridge-payout.json'))).toBe(true)
    expect(sawCall(w, 'cluster start')).toBe(false)
    expect(fs.readdirSync(w.shm)).toEqual([])
    noSecretsIn(r.out)
  })

  it.skipIf(isRoot)('a failure before the wipe leaves the originals in place and no staged copy behind', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 4, 5], payout: [3] })
    // the bundle cannot be copied into the volume: this fails after the keys are staged and before `cluster sync`
    fs.writeFileSync(path.join(w.remoteDir, 'dist', 'unreadable.js'), 'x', { mode: 0o000 })
    const r = run('bash', [REDEPLOY], { env: envFor(w) })
    expect(r.status).not.toBe(0)
    expect(sawCall(w, 'cluster sync')).toBe(false)
    expect(fs.readdirSync(w.shm)).toEqual([])
    for (let n = 1; n <= 5; n++) expect(JSON.parse(fs.readFileSync(path.join(w.vol.seedDir(n), 'bridge-keys.json'), 'utf8'))).toEqual(dummyKeys(n))
    expect(fs.existsSync(path.join(w.vol.seedDir(3), 'bridge-payout.json'))).toBe(true)
    noSecretsIn(r.out)
  })

  it.skipIf(isRoot)('keeps the keys staged, and prints where and how to restore them, when a key cannot be put back', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 4, 5], payout: [2] })
    const r = run('bash', [REDEPLOY], { env: envFor(w, { STUB_BREAK_NODE: '3' }) })
    expect(r.status).toBe(1)
    const staged = fs.readdirSync(w.shm)
    expect(staged).toHaveLength(1)
    const stage = path.join(w.shm, staged[0])
    expect(modeOf(stage)).toBe(0o700)
    expect(fs.readdirSync(stage).sort()).toEqual(['RESTORE-KEYS.sh', 'node1.json', 'node2.json', 'node2.payout.json', 'node3.json', 'node4.json', 'node5.json'])
    expect(r.out).toContain(stage)
    expect(r.out).toContain(`bash ${stage}/RESTORE-KEYS.sh`)
    expect(r.out).toMatch(/NOT confirmed back on the nodes/)
    expect(sawCall(w, 'cluster start')).toBe(false)
    // the nodes that could be restored were
    expect(fs.existsSync(path.join(w.vol.seedDir(1), 'bridge-keys.json'))).toBe(true)
    expect(fs.existsSync(path.join(w.vol.seedDir(3), 'bridge-keys.json'))).toBe(false)
    noSecretsIn(r.out)

    // Fix the cause, run the printed command: every key is back, checked, and the staged copies are shredded.
    fs.chmodSync(w.vol.seedDir(3), 0o700)
    const fix = run('bash', [path.join(stage, 'RESTORE-KEYS.sh')])
    expect(fix.status, fix.out).toBe(0)
    for (let n = 1; n <= 5; n++) expect(JSON.parse(fs.readFileSync(path.join(w.vol.seedDir(n), 'bridge-keys.json'), 'utf8'))).toEqual(dummyKeys(n))
    expect(fs.existsSync(path.join(w.vol.seedDir(2), 'bridge-payout.json'))).toBe(true)
    expect(fs.existsSync(stage)).toBe(false)
    noSecretsIn(fix.out)
  })

})

describe('snapshot-pull.sh: any n, state only', () => {
  it('writes a tar of every node state directory and nothing from the key files', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 4, 5], payout: [1] })
    const env: Record<string, string> = { ...process.env, ...envFor(w), NODES: '' } as Record<string, string>
    // bytes, not text: run it by hand rather than through the string-decoding helper
    const r = spawnSync('bash', [SNAPSHOT], { env, cwd: PKG, maxBuffer: 64 * 1024 * 1024 })
    expect(r.status, r.stderr.toString()).toBe(0)
    const names = spawnSync('tar', ['tf', '-'], { input: r.stdout, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    for (let n = 1; n <= 5; n++) {
      expect(names).toContain(`node${n}/contract_fs/seed/state/config.json`)
      expect(names).toContain(`node${n}/contract_fs/seed/state/cursor.json`)
    }
    expect(names.filter((x) => /bridge-keys|bridge-payout|\.key$/.test(x))).toEqual([])
    expect(names.every((x) => /^node[1-5]\/contract_fs\/seed\/state\/[a-z-]+\.json$/.test(x))).toBe(true)
    expect(sawCall(w, 'cluster stop')).toBe(true)
    // messages went to stderr, none of them are the keys
    noSecretsIn(r.stderr.toString())
  })

  it('refuses a node count that does not match the volume, before stopping anything', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 4, 5] })
    const r = run('bash', [SNAPSHOT], { env: envFor(w, { NODES: '3' }) })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/holds 5 node directories but the snapshot is for 3/)
    expect(dockerCalls(w)).toEqual([])
  })

  it('refuses when a node has no state files, before stopping anything', () => {
    const w = world({ nodes: 3, keys: [1, 2, 3] })
    fs.rmSync(path.join(w.vol.seedDir(2), 'state'), { recursive: true })
    fs.mkdirSync(path.join(w.vol.seedDir(2), 'state'))
    const r = run('bash', [SNAPSHOT], { env: envFor(w, { NODES: '' }) })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/node 2 has no state files/)
    expect(sawCall(w, 'cluster stop')).toBe(false)
  })

  it('does not copy while nodes are still running', () => {
    const w = world({ nodes: 3, keys: [1, 2, 3] })
    const r = run('bash', [SNAPSHOT], { env: envFor(w, { NODES: '', STUB_RUNNING: '1' }) })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/still running/)
    expect(r.stdout).toBe('')
  })
})

describe('cluster-manage.sh: create for n nodes, destroy guarded', () => {
  const mainnetConfig = { k: 3, n: 5, feed: 'xrpl', xrpl: { rpc: ['https://xrplcluster.com/'], lockAccount: 'rLock', fundingAccount: 'rFund' }, evm: { chainId: 1440000, rpc: [], minter: '0x1' } }

  it('inspect prints addresses and what is lost, and no secret', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 4, 5], payout: [3] })
    const r = run('bash', [MANAGE], { env: envFor(w, { CMD: 'inspect' }) })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('rDummyNode4Address')
    expect(r.out).toContain('0xdummynode5address')
    expect(r.out).toMatch(/node 3: .*payout file yes/)
    expect(r.out).toMatch(/= 5 node\(s\)/)
    noSecretsIn(r.out)
    expect(fs.existsSync(w.vol.vol)).toBe(true)
  })

  it('refuses to destroy a cluster named main without CONFIRM_DESTROY, and prints what would be lost', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 4, 5] })
    const r = run('bash', [MANAGE], { env: envFor(w, { CMD: 'destroy' }) })
    expect(r.status).toBe(3)
    expect(r.out).toMatch(/REFUSED: it is named 'main'/)
    expect(r.out).toContain('rDummyNode1Address')
    expect(r.out).toMatch(/CONFIRM_DESTROY=main/)
    expect(fs.existsSync(path.join(w.vol.seedDir(1), 'bridge-keys.json'))).toBe(true)
    expect(sawCall(w, 'volume rm')).toBe(false)
    expect(sawCall(w, 'cluster destroy')).toBe(false)
    noSecretsIn(r.out)
  })

  it('refuses with the wrong confirmation and goes ahead with the right one', () => {
    const w = world({ nodes: 3, keys: [1, 2, 3] })
    expect(run('bash', [MANAGE], { env: envFor(w, { CMD: 'destroy', CONFIRM_DESTROY: 'yes' }) }).status).toBe(3)
    expect(fs.existsSync(w.vol.vol)).toBe(true)
    const ok = run('bash', [MANAGE], { env: envFor(w, { CMD: 'destroy', CONFIRM_DESTROY: 'main' }) })
    expect(ok.status, ok.out).toBe(0)
    expect(ok.out).toMatch(/going ahead/)
    expect(ok.out).toMatch(/cluster main destroyed/)
    expect(fs.existsSync(w.vol.vol)).toBe(false)
    expect(sawCall(w, 'volume rm hpdevkit_main_vol')).toBe(true)
  })

  it('protects a cluster whose state points at mainnet whatever it is called', () => {
    const w = world({ nodes: 5, keys: [1, 2, 3, 4, 5], cluster: 'scratch', config: mainnetConfig })
    const r = run('bash', [MANAGE], { env: envFor(w, { CMD: 'destroy', REMOTE_DIR: path.join(w.root, 'nowhere') }) })
    expect(r.status).toBe(3)
    expect(r.out).toMatch(/points at mainnet/)
    expect(fs.existsSync(w.vol.vol)).toBe(true)
    expect(run('bash', [MANAGE], { env: envFor(w, { CMD: 'destroy', CONFIRM_DESTROY: 'scratch', REMOTE_DIR: path.join(w.root, 'nowhere') }) }).status).toBe(0)
  })

  it('protects a cluster whose deployed genesis points at mainnet before any node has run it', () => {
    const w = world({ nodes: 3, keys: [], cluster: 'scratch' })
    fs.writeFileSync(path.join(w.remoteDir, 'dist', 'genesis.json'), JSON.stringify({ config: mainnetConfig }))
    const r = run('bash', [MANAGE], { env: envFor(w, { CMD: 'destroy', CLUSTER: 'scratch', REMOTE_DIR: w.remoteDir }) })
    expect(r.status).toBe(3)
  })

  it('protects a cluster the caller says is mainnet', () => {
    const w = world({ nodes: 3, keys: [1, 2, 3], cluster: 'scratch' })
    expect(run('bash', [MANAGE], { env: envFor(w, { CMD: 'destroy', MAINNET: '1' }) }).status).toBe(3)
  })

  it('does not ask for confirmation to destroy a test cluster, but still says what is lost', () => {
    const w = world({ nodes: 3, keys: [1, 2, 3], cluster: 'scratch' })
    const r = run('bash', [MANAGE], { env: envFor(w, { CMD: 'destroy', REMOTE_DIR: path.join(w.root, 'nowhere') }) })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/destroying it deletes/)
    expect(fs.existsSync(w.vol.vol)).toBe(false)
  })

  it('never destroys hpdevkit_default', () => {
    const w = world({ nodes: 3, keys: [1, 2, 3], cluster: 'default' })
    const r = run('bash', [MANAGE], { env: envFor(w, { CMD: 'destroy', CLUSTER: 'default' }) })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/default cluster is hpdevkit's own/)
  })

  it('creates a cluster of n nodes: the manager environment carries CLUSTER_SIZE and the ports', () => {
    const w = world({ nodes: 5, keys: [] })
    for (let n = 1; n <= 5; n++) {
      fs.mkdirSync(path.join(w.vol.vol, `node${n}`, 'cfg'), { recursive: true })
      fs.writeFileSync(path.join(w.vol.vol, `node${n}`, 'cfg', 'hp.cfg'), JSON.stringify({ contract: { id: `id${n}`, unl: [] }, mesh: { known_peers: [], port: 22870 + n }, user: { port: 8090 + n } }))
    }
    const r = run('bash', [MANAGE], { env: envFor(w, { CMD: 'create', NODES: '5', USER_PORT: '8091', PEER_PORT: '22871', STUB_CONTAINERS: '' }) })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/5 node\(s\), user ports 8091-8095, peer ports 22871-22875/)
    const runs = dockerCalls(w).filter((c) => c.startsWith('run '))
    expect(runs).toHaveLength(2)
    for (const call of runs) {
      expect(call).toContain('-e CLUSTER_SIZE=5')
      expect(call).toContain('-e CLUSTER=main')
      expect(call).toContain('-e HP_USER_PORT_BEGIN=8091')
      expect(call).toContain('-e HP_PEER_PORT_BEGIN=22871')
      expect(call).toContain('-e VOLUME=hpdevkit_main_vol')
      expect(call).not.toContain('CLUSTER_SIZE=3')
    }
    // one hp.cfg summary line per node
    expect(r.stdout.split('\n').filter((l) => l.startsWith('{"id"'))).toHaveLength(5)
  })

  it('create adds CLUSTER_SIZE when the default manager does not carry it', () => {
    const w = world({ nodes: 3, keys: [] })
    for (let n = 1; n <= 3; n++) {
      fs.mkdirSync(path.join(w.vol.vol, `node${n}`, 'cfg'), { recursive: true })
      fs.writeFileSync(path.join(w.vol.vol, `node${n}`, 'cfg', 'hp.cfg'), JSON.stringify({ contract: { id: 'x', unl: [] }, mesh: { known_peers: [], port: 1 }, user: { port: 2 } }))
    }
    // a docker double whose default manager has no CLUSTER_SIZE line
    const bin = path.join(w.root, 'bin2')
    fs.mkdirSync(bin)
    const base = fs.readFileSync(w.docker, 'utf8').replace('CLUSTER_SIZE=3\\n', '')
    const docker = path.join(bin, 'docker')
    fs.writeFileSync(docker, base, { mode: 0o755 })
    const r = run('bash', [MANAGE], { env: envFor(w, { CMD: 'create', NODES: '3', DOCKER: docker }) })
    expect(r.status, r.out).toBe(0)
    expect(dockerCalls(w).filter((c) => c.startsWith('run ')).every((c) => c.includes('-e CLUSTER_SIZE=3'))).toBe(true)
  })

  it('create needs a node count', () => {
    const w = world({ nodes: 3, keys: [] })
    const r = run('bash', [MANAGE], { env: envFor(w, { CMD: 'create', NODES: undefined as unknown as string }) })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/NODES is required/)
  })
})
