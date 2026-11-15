import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupTmp, fakeGenesis, makeSandbox, run, tmpDir, writeForbiddenStubs } from './ops-helpers'

/**
 * The orchestrators (deploy-dev.sh, snapshot-state.sh, hpdevkit-cluster.sh, evernode-cluster.sh) in DRY_RUN=1. ssh, rsync,
 * npm, scp, docker and evdevkit are doubles that fail the test if anything calls them: a dry run must print, not run.
 */
afterAll(cleanupTmp)

interface Box {
  dir: string
  log: string
  env: Record<string, string>
}

function box(genesis: Record<string, unknown>): Box {
  const root = tmpDir()
  const dir = makeSandbox(root, genesis)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  writeForbiddenStubs(bin, ['ssh', 'rsync', 'npm', 'scp', 'docker', 'evdevkit'])
  const log = path.join(root, 'forbidden.log')
  return { dir, log, env: { PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, DRY_RUN: '1', CLUSTER_SIZE: undefined as unknown as string, GENESIS: undefined as unknown as string, CLUSTER: undefined as unknown as string, ACCEPT_NEW_KEYS: undefined as unknown as string } }
}
const forbiddenCalls = (b: Box) => (fs.existsSync(b.log) ? fs.readFileSync(b.log, 'utf8') : '')
const sh = (b: Box, script: string, env: Record<string, string> = {}, args: string[] = []) => run('bash', [path.join(b.dir, 'scripts', script), ...args], { cwd: b.dir, env: { ...b.env, ...env } })

const five = fakeGenesis({ n: 5, k: 3, mainnet: true })
const dev = fakeGenesis({ n: 3, k: 2 })

describe('deploy-dev.sh DRY_RUN', () => {
  it('prints the whole redeploy for a five-node mainnet genesis and runs nothing', () => {
    const b = box({ mainnet: five, dev })
    const r = sh(b, 'deploy-dev.sh', { GENESIS: 'mainnet', CLUSTER: 'main' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('DRY_RUN=1')
    expect(r.out).toContain('cluster main on bridge-host: 5 node(s), genesis mainnet (MAINNET)')
    expect(r.out).toContain('+ npm run --silent build')
    expect(r.out).toContain('+ rsync -az --delete dist/ bridge-host:/root/bridge-cluster-main/dist/')
    expect(r.out).toMatch(/\+ ssh bridge-host env CLUSTER=main REMOTE_DIR=\/root\/bridge-cluster-main NODES=5 MAINNET=1 ACCEPT_NEW_KEYS= bash -s < scripts\/remote\/redeploy\.sh/)
    // the remote script is printed too, so the dry run shows what would run on the host
    expect(r.out).toContain('    | ')
    expect(r.out).toContain('cluster sync')
    expect(forbiddenCalls(b)).toBe('')
  })

  it('takes the node count of a three-node dev genesis and the default cluster', () => {
    const b = box({ dev })
    const r = sh(b, 'deploy-dev.sh')
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('cluster default on bridge-host: 3 node(s), genesis dev')
    expect(r.out).toContain('NODES=3 MAINNET=0')
    expect(r.out).toContain('REMOTE_DIR=/root/bridge-cluster ')
    expect(forbiddenCalls(b)).toBe('')
  })

  it('CLUSTER_SIZE must agree with the genesis', () => {
    const b = box({ mainnet: five })
    const r = sh(b, 'deploy-dev.sh', { GENESIS: 'mainnet', CLUSTER: 'main', CLUSTER_SIZE: '4' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/CLUSTER_SIZE=4 but genesis\/mainnet\.json says n=5/)
    expect(r.out).not.toContain('+ rsync')
    const ok = sh(b, 'deploy-dev.sh', { GENESIS: 'mainnet', CLUSTER: 'main', CLUSTER_SIZE: '5' })
    expect(ok.status, ok.out).toBe(0)
  })

  it('passes ACCEPT_NEW_KEYS on, and refuses a value that is not a plain list before any command', () => {
    const b = box({ mainnet: five })
    const ok = sh(b, 'deploy-dev.sh', { GENESIS: 'mainnet', CLUSTER: 'main', ACCEPT_NEW_KEYS: 'all' })
    expect(ok.out).toContain('ACCEPT_NEW_KEYS=all')
    const bad = sh(b, 'deploy-dev.sh', { GENESIS: 'mainnet', CLUSTER: 'main', ACCEPT_NEW_KEYS: '4; rm -rf /' })
    expect(bad.status).toBe(1)
    expect(bad.out).toMatch(/refusing to send/)
    expect(forbiddenCalls(b)).toBe('')
  })

  it('prints the genesis refresh for a test network instead of running it', () => {
    const b = box({ devnet: fakeGenesis({ n: 3, k: 2, feed: 'xrpl' }) })
    const r = sh(b, 'deploy-dev.sh', { GENESIS: 'devnet' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('+ XRPL_NETWORK=devnet npx tsx scripts/testnet-setup.ts')
    expect(forbiddenCalls(b)).toBe('')
  })

  it('reads the node count of a snapshot, and says so when it cannot yet', () => {
    const b = box({ dev })
    const unknown = sh(b, 'deploy-dev.sh', { GENESIS: 'snapshot' })
    expect(unknown.status, unknown.out).toBe(0)
    expect(unknown.out).toContain('NODES=UNKNOWN')
    expect(unknown.out).toMatch(/set CLUSTER_SIZE to preview/)
    const sized = sh(b, 'deploy-dev.sh', { GENESIS: 'snapshot', CLUSTER_SIZE: '5' })
    expect(sized.out).toContain('NODES=5')
    expect(sized.out).toContain('scripts/remote/snapshot-pull.sh')
  })

  it('SNAPSHOT_REUSE boots from the snapshot that is already there and pulls nothing off a cluster', () => {
    const b = box({ dev })
    fs.writeFileSync(path.join(b.dir, 'genesis', 'snapshot.json'), JSON.stringify(fakeGenesis({ n: 5, k: 3 })))
    const r = sh(b, 'deploy-dev.sh', { GENESIS: 'snapshot', SNAPSHOT_REUSE: '1', CLUSTER: 'main' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('SNAPSHOT_REUSE=1: booting from genesis/snapshot.json as it is')
    expect(r.out).not.toContain('snapshot-pull.sh')
    expect(r.out).toContain('NODES=5')
    expect(forbiddenCalls(b)).toBe('')
    const missing = sh(box({ dev }), 'deploy-dev.sh', { GENESIS: 'snapshot', SNAPSHOT_REUSE: '1' })
    expect(missing.status).toBe(1)
    expect(missing.out).toMatch(/genesis\/snapshot\.json does not exist/)
  })

  it('will not put a mainnet cluster on one host, or wipe it with a fresh genesis, without being told it is meant', () => {
    const b = box({ mainnet: five })
    const live = { GENESIS: 'mainnet', CLUSTER: 'main', DRY_RUN: '0' }
    const noAck = sh(b, 'deploy-dev.sh', live)
    expect(noAck.status, noAck.out).not.toBe(0)
    expect(noAck.out).toMatch(/ONE host/)
    expect(noAck.out).toMatch(/ACK_SINGLE_HOST=1/)
    const noFresh = sh(b, 'deploy-dev.sh', { ...live, ACK_SINGLE_HOST: '1' })
    expect(noFresh.status, noFresh.out).not.toBe(0)
    expect(noFresh.out).toMatch(/FRESH_MAINNET=1/)
    expect(noFresh.out).toMatch(/GENESIS=snapshot/)
    expect(forbiddenCalls(b)).toBe('') // refused before any build, rsync or ssh
    // a dry run only warns, so the plan can still be read
    const dry = sh(b, 'deploy-dev.sh', { GENESIS: 'mainnet', CLUSTER: 'main' })
    expect(dry.status, dry.out).toBe(0)
    expect(dry.out).toMatch(/WARNING: this script runs every node/)
    // and once both are said, neither is repeated
    const said = sh(b, 'deploy-dev.sh', { GENESIS: 'mainnet', CLUSTER: 'main', ACK_SINGLE_HOST: '1', FRESH_MAINNET: '1' })
    expect(said.status, said.out).toBe(0)
    expect(said.out).not.toMatch(/WARNING: this script runs every node|WARNING: GENESIS=mainnet wipes/)
  })

  it('does not ask for either on a snapshot redeploy of a test network', () => {
    const b = box({ dev })
    const r = sh(b, 'deploy-dev.sh', { GENESIS: 'dev' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).not.toMatch(/ACK_SINGLE_HOST|FRESH_MAINNET/)
  })

  it('refuses a mainnet genesis that is missing, and names that are not plain', () => {
    const b = box({ dev })
    expect(sh(b, 'deploy-dev.sh', { GENESIS: 'mainnet' }).out).toMatch(/genesis\/mainnet\.json is missing/)
    expect(sh(b, 'deploy-dev.sh', { GENESIS: '../etc' }).status).toBe(1)
    expect(sh(b, 'deploy-dev.sh', { CLUSTER: 'a b' }).status).toBe(1)
  })

  it('a dry run of an unreadable or inconsistent genesis fails instead of guessing', () => {
    const b = box({ dev: { config: { n: 3, k: 5 } } })
    const r = sh(b, 'deploy-dev.sh')
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/config\.k must be an integer from 1 to n/)
  })
})

describe('snapshot-state.sh DRY_RUN', () => {
  it('prints the pull for n nodes and the assemble step', () => {
    const b = box({ dev })
    const r = sh(b, 'snapshot-state.sh', { CLUSTER: 'main', CLUSTER_SIZE: '5', SNAPSHOT_MIN_AGREE: '4' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('ssh bridge-host env CLUSTER=main NODES=5 bash -s < scripts/remote/snapshot-pull.sh')
    expect(r.out).toContain('SNAPSHOT_MIN_AGREE=4')
    expect(r.out).toContain('npx tsx scripts/snapshot-state.ts .snapshot')
    expect(forbiddenCalls(b)).toBe('')
    expect(fs.existsSync(path.join(b.dir, '.snapshot'))).toBe(false)
  })

  it('from a backup copy it touches no host and stops no cluster', () => {
    const b = box({ dev })
    const r = sh(b, 'snapshot-state.sh', { STATE_FROM: '/backups/state-main-node1-20261009T120000Z-4242', CLEAR_OPERATORS: '1' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('+ STATE_FROM=/backups/state-main-node1-20261009T120000Z-4242')
    expect(r.out).toContain('CLEAR_OPERATORS=1')
    expect(r.out).not.toContain('snapshot-pull.sh')
    expect(forbiddenCalls(b)).toBe('')
  })

  it('without a size lets the host count its node directories', () => {
    const b = box({ dev })
    const r = sh(b, 'snapshot-state.sh');
    expect(r.out).toContain('NODES= bash -s')
    expect(sh(b, 'snapshot-state.sh', { CLUSTER_SIZE: 'five' }).status).toBe(1)
  })
})

describe('hpdevkit-cluster.sh DRY_RUN', () => {
  it('refuses destroy for main before any ssh, and for a cluster whose genesis is mainnet', () => {
    const b = box({ mainnet: five })
    const main = sh(b, 'hpdevkit-cluster.sh', { CLUSTER: 'main' }, ['destroy'])
    expect(main.status).toBe(3)
    expect(main.out).toMatch(/REFUSED: cluster 'main' is the mainnet cluster/)
    expect(main.out).toMatch(/CONFIRM_DESTROY=main/)
    expect(main.out).not.toContain('+ ssh')
    const other = sh(b, 'hpdevkit-cluster.sh', { CLUSTER: 'rehearsal', GENESIS: 'mainnet' }, ['destroy'])
    expect(other.status).toBe(3)
    const wrong = sh(b, 'hpdevkit-cluster.sh', { CLUSTER: 'main', CONFIRM_DESTROY: 'default' }, ['destroy'])
    expect(wrong.status).toBe(3)
    expect(forbiddenCalls(b)).toBe('')
  })

  it('with the confirmation, prints the destroy that the host will still check', () => {
    const b = box({ mainnet: five })
    const r = sh(b, 'hpdevkit-cluster.sh', { CLUSTER: 'main', CONFIRM_DESTROY: 'main' }, ['destroy'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('CMD=destroy CLUSTER=main REMOTE_DIR=/root/bridge-cluster-main MAINNET=0 CONFIRM_DESTROY=main')
    expect(forbiddenCalls(b)).toBe('')
  })

  it('does not ask a test cluster for a confirmation', () => {
    const b = box({ dev })
    const r = sh(b, 'hpdevkit-cluster.sh', { CLUSTER: 'rehearsal' }, ['destroy'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('CMD=destroy CLUSTER=rehearsal')
  })

  it('create takes n from CLUSTER_SIZE or the genesis, never a default', () => {
    const b = box({ mainnet: five, dev })
    const none = sh(b, 'hpdevkit-cluster.sh', { CLUSTER: 'main' }, ['create'])
    expect(none.status).toBe(1)
    expect(none.out).toMatch(/there is no default size/)
    const sized = sh(b, 'hpdevkit-cluster.sh', { CLUSTER: 'main', CLUSTER_SIZE: '5' }, ['create'])
    expect(sized.status, sized.out).toBe(0)
    expect(sized.out).toContain('creating cluster main with 5 node(s): user ports 8091-8095, peer ports 22871-22875')
    expect(sized.out).toContain('CMD=create CLUSTER=main NODES=5 USER_PORT=8091 PEER_PORT=22871')
    const fromGenesis = sh(b, 'hpdevkit-cluster.sh', { CLUSTER: 'main', GENESIS: 'mainnet' }, ['create'])
    expect(fromGenesis.out).toContain('NODES=5')
    const disagree = sh(b, 'hpdevkit-cluster.sh', { CLUSTER: 'main', GENESIS: 'mainnet', CLUSTER_SIZE: '3' }, ['create'])
    expect(disagree.status).toBe(1)
    expect(disagree.out).toMatch(/CLUSTER_SIZE=3 but genesis\/mainnet\.json says n=5/)
    expect(forbiddenCalls(b)).toBe('')
  })

  it('will not touch the default cluster, and inspect is a plain read', () => {
    const b = box({ dev })
    expect(sh(b, 'hpdevkit-cluster.sh', { CLUSTER: 'default' }, ['destroy']).status).toBe(1)
    const r = sh(b, 'hpdevkit-cluster.sh', { CLUSTER: 'main' }, ['inspect'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('CMD=inspect CLUSTER=main')
  })
})

describe('evernode-cluster.sh DRY_RUN', () => {
  function evernodeBox(n: number) {
    const b = box({ dev })
    fs.mkdirSync(path.join(b.dir, 'dist'))
    fs.writeFileSync(path.join(b.dir, 'dist', 'index.js'), '')
    fs.writeFileSync(path.join(b.dir, 'dist', 'genesis.json'), JSON.stringify(fakeGenesis({ n, k: Math.max(1, n - 2) })))
    fs.mkdirSync(path.join(b.dir, 'hp'))
    // One address per instance, as the lease script needs, shaped like real ones.
    fs.writeFileSync(path.join(b.dir, 'hp', 'hosts.txt'), Array.from({ length: n }, (_, i) => `r${'a'.repeat(24)}${String.fromCharCode(97 + i)}`).join('\n') + '\n')
    return b
  }

  it('sizes the cluster from the built genesis and reads no wallet', () => {
    const b = evernodeBox(5)
    const r = sh(b, 'evernode-cluster.sh', { WALLET_FILE: path.join(b.dir, 'no-such-wallet.txt') })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('nodes: 5 (n from dist/genesis.json)')
    expect(r.out).toMatch(/\+ HOSTS=hp\/hosts\.txt SIZE=5 MOMENTS=2 IMAGE=\S+ DIST=\S+\/dist CONSENSUS_PCT=59 npx --no-install tsx scripts\/evernode-spread\.ts/)
    expect(r.out).toContain('HotPocket consensus threshold: 59% (k=3 of n=5 nodes close a ledger')
    // the plan: one instance on each of five different hosts, the first as the primary, then the bundle
    expect(r.out).toContain('5 instance(s), one on each of:')
    expect(r.out.match(/\+ evdevkit acquire /g)).toHaveLength(5)
    expect(r.out).toMatch(/\+ evdevkit acquire r\w+ -m 2 -c [0-9a-f-]{36} -i \S+ {3}\(the primary: base settings\)/)
    expect(r.out).toMatch(/\+ evdevkit deploy <bundle> <primary domain> <primary user port>/)
    expect(r.out).not.toContain('cluster-create')
    expect(r.out).toContain('never printed')
    expect(forbiddenCalls(b)).toBe('')
  })

  it('prints the placement check it will run, and does not touch the network in a dry run', () => {
    const b = evernodeBox(5)
    const r = sh(b, 'evernode-cluster.sh', {})
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/\+ npx --no-install tsx scripts\/evernode-hosts\.ts check hp\/hosts\.txt --n 5 --k 3 --moments 2/)
    expect(r.out).toMatch(/refuses a host operator that would run 3 or more of 5/)
    const skipped = sh(b, 'evernode-cluster.sh', { SKIP_PLACEMENT_CHECK: '1' })
    expect(skipped.status, skipped.out).toBe(0)
    expect(skipped.out).not.toMatch(/evernode-hosts\.ts check/)
  })

  it('never lets a mainnet genesis skip the placement check', () => {
    const b = evernodeBox(3)
    fs.writeFileSync(path.join(b.dir, 'dist', 'genesis.json'), JSON.stringify(fakeGenesis({ n: 3, k: 2, mainnet: true })))
    const r = sh(b, 'evernode-cluster.sh', { SKIP_PLACEMENT_CHECK: '1' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/SKIP_PLACEMENT_CHECK is not allowed for a mainnet genesis/)
    expect(sh(b, 'evernode-cluster.sh', {}).status).toBe(0)
  })

  it('refuses a hosts file with fewer hosts than instances, before anything is leased', () => {
    const b = evernodeBox(5)
    fs.writeFileSync(path.join(b.dir, 'hp', 'hosts.txt'), `r${'a'.repeat(24)}a\nr${'a'.repeat(24)}b\n`)
    const r = sh(b, 'evernode-cluster.sh', { SKIP_PLACEMENT_CHECK: '1' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/lists 2 host\(s\) for 5 instances: each instance needs a host of its own/)
  })

  it('refuses a SIZE that disagrees with the genesis', () => {
    const b = evernodeBox(5)
    const r = sh(b, 'evernode-cluster.sh', { SIZE: '3' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/SIZE=3 but dist\/genesis\.json says n=5/)
    const viaClusterSize = sh(b, 'evernode-cluster.sh', { CLUSTER_SIZE: '4' })
    expect(viaClusterSize.status).toBe(1)
  })

  it('runs three nodes at the threshold at which two are enough, not at HotPocket\'s 80%, which needs all three', () => {
    const b = evernodeBox(3)
    fs.writeFileSync(path.join(b.dir, 'dist', 'genesis.json'), JSON.stringify(fakeGenesis({ n: 3, k: 2 })))
    const r = sh(b, 'evernode-cluster.sh', {})
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('HotPocket consensus threshold: 66% (k=2 of n=3 nodes close a ledger')
    expect(r.out).toContain('CONSENSUS_PCT=66')
    expect(r.out).toContain('consensus threshold 66%')
  })

  it('lets CONSENSUS_PCT override it, and refuses a genesis whose k is not more than half of n', () => {
    const b = evernodeBox(3)
    fs.writeFileSync(path.join(b.dir, 'dist', 'genesis.json'), JSON.stringify(fakeGenesis({ n: 3, k: 2 })))
    expect(sh(b, 'evernode-cluster.sh', { CONSENSUS_PCT: '80' }).out).toContain('HotPocket consensus threshold: 80%')
    fs.writeFileSync(path.join(b.dir, 'dist', 'genesis.json'), JSON.stringify(fakeGenesis({ n: 4, k: 2 })))
    const odd = sh(b, 'evernode-cluster.sh', {})
    expect(odd.status).toBe(1)
    expect(odd.out).toMatch(/cannot work out the consensus threshold for k=2 of n=4/)
  })
})

describe('evernode-extend.sh', () => {
  function listBox(nodes: { host: string; name: string }[]) {
    const b = box({ dev })
    const list = path.join(b.dir, 'cluster.json')
    fs.writeFileSync(list, JSON.stringify({ nodes }))
    return { b, list }
  }
  const nodes = [
    { host: 'rHostAaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'AAAAAAAA11111111' },
    { host: 'rHostBbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'BBBBBBBB22222222' },
  ]

  it('prints the lines it would send and reads no wallet in a dry run', () => {
    const { b, list } = listBox(nodes)
    const r = sh(b, 'evernode-extend.sh', { LIST: list, WALLET_FILE: path.join(b.dir, 'no-such-wallet.txt') }, ['720'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('extending 2 instance(s)')
    expect(r.out).toContain('+720')
    expect(r.out).toContain('the tenant seed is not read and nothing is sent')
    expect(forbiddenCalls(b)).toBe('')
  })

  it('wants a whole number of moments, not more than 180 days of them', () => {
    const { b, list } = listBox(nodes)
    for (const bad of ['', '0', 'abc', '-3', '1.5', '4321']) {
      const r = sh(b, 'evernode-extend.sh', { LIST: list }, bad === '' ? [] : [bad])
      expect(r.status, bad).toBe(1)
    }
    expect(forbiddenCalls(b)).toBe('')
  })

  it('refuses a list that is missing or holds no instance', () => {
    const { b } = listBox([])
    expect(sh(b, 'evernode-extend.sh', { LIST: path.join(b.dir, 'cluster.json') }, ['1']).status).toBe(1)
    const missing = sh(b, 'evernode-extend.sh', { LIST: path.join(b.dir, 'nope.json') }, ['1'])
    expect(missing.status).toBe(1)
    expect(missing.out).toMatch(/instance list .* missing/)
  })
})
