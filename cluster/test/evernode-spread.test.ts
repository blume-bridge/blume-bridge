import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { initConfigFor, overrideFor, parseInstance, type Instance } from '../scripts/evernode-spread'
import { PKG, cleanupTmp, run, tmpDir } from './ops-helpers'

/**
 * Leasing a cluster one instance on each host. evdevkit is a stand-in that prints what the real one prints and records what it
 * was given, so the order, the settings each instance gets and the bundle are checked without leasing anything. The rehearsal
 * of 2026-10-18 showed `evdevkit cluster-create` putting two of three instances on one host and none on the third.
 */
afterAll(cleanupTmp)

const HOSTS = ['rHostAaaaaaaaaaaaaaaaaaaaaaaaaa', 'rHostBbbbbbbbbbbbbbbbbbbbbbbbbb', 'rHostCccccccccccccccccccccccccc', 'rHostDdddddddddddddddddddddddddd']
const TENANT_SECRET = 'sEdTENANTSECRETdummy11111111111111'
const USER_KEY = 'USERPRIVATEKEYdummy2222222222222222'

const SHIM = `#!/bin/bash
# stand-in for evdevkit: prints what the real one prints, records what it was given
cmd="$1"; shift
echo "$cmd $*" >> "$SHIM_DIR/calls.log"
if [ -z "$EV_TENANT_SECRET" ] || [ -z "$EV_USER_PRIVATE_KEY" ]; then echo "SHIM: the secrets did not reach evdevkit" >> "$SHIM_DIR/calls.log"; fi
case "$cmd" in
  acquire)
    host="$1"
    cp "$EV_HP_INIT_CFG_PATH" "$SHIM_DIR/init-$host.json"
    if [ "$host" = "$FAIL_HOST" ]; then echo "Error occurred while acquiring the instance: No offers available."; exit 0; fi
    n=$(printf '%s' "$host" | cksum | cut -d' ' -f1)
    key="ed$(printf '%s' "$host" | shasum -a 256 | cut -c1-64)"
    printf "\\033[32mInstance created!\\033[0m {\\n  host: '%s',\\n  name: 'NAME%s',\\n  pubkey: '%s',\\n  contract_id: 'c',\\n  peer_port: '%s',\\n  user_port: '%s',\\n  domain: 'h-%s.example.net',\\n  privateKey: 'deadbeef00',\\n  created_timestamp: 1\\n}\\n" "$host" "$n" "$key" "$((22000 + n % 1000))" "$((26000 + n % 1000))" "$n"
    ;;
  bundle)
    cp "$EV_HP_OVERRIDE_CFG_PATH" "$SHIM_DIR/override.json"
    mkdir -p "$(dirname "$1")/../bundle"; echo zip > "$(dirname "$1")/../bundle/bundle.zip"
    echo "Archive finished. (location: x/bundle/bundle.zip)"
    ;;
  deploy)
    echo "Contract bundle uploaded!"
    ;;
esac
exit 0
`

function world(over: { hosts?: string[]; size?: number } = {}) {
  const dir = tmpDir('spread-')
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'evdevkit'), SHIM, { mode: 0o755 })
  const dist = path.join(dir, 'pkg', 'dist')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'app.js'), 'exports.contract = () => {}\n')
  const hosts = path.join(dir, 'hosts.txt')
  fs.writeFileSync(hosts, `${(over.hosts ?? HOSTS).join('\n')}\n`)
  const init = path.join(dir, 'init.json')
  fs.writeFileSync(init, JSON.stringify({ mesh: { peer_discovery: { enabled: false } } }))
  const override = path.join(dir, 'override.json')
  fs.writeFileSync(override, JSON.stringify({ contract: { consensus: { roundtime: 3000 } } }))
  const out = path.join(dir, 'keys', 'evernode-cluster.json')
  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${bin}:${process.env.PATH}`,
    SHIM_DIR: dir,
    HOSTS: hosts,
    SIZE: String(over.size ?? 3),
    MOMENTS: '72',
    IMAGE: 'evernode/sashimono:test',
    DIST: dist,
    OUT: out,
    WAIT_SYNC_S: '0',
    SKIP_OFFERS_CHECK: '1',
    SKIP_VERIFY: '1',
    EV_TENANT_SECRET: TENANT_SECRET,
    EV_USER_PRIVATE_KEY: USER_KEY,
    EV_HP_INIT_CFG_PATH: init,
    EV_HP_OVERRIDE_CFG_PATH: override,
    ...extra,
  })
  const spread = (extra: Record<string, string> = {}) => run('npx', ['tsx', 'scripts/evernode-spread.ts'], { cwd: PKG, env: env(extra) })
  const calls = () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n') : [])
  const json = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
  return { dir, dist, out, spread, calls, json }
}

describe('leasing a cluster, one instance on each host', () => {
  it('leases each host once, in the order of the list, then bundles and uploads once', () => {
    const w = world()
    const r = w.spread()
    expect(r.status, r.out).toBe(0)
    const c = w.calls()
    expect(c.map((l) => l.split(' ')[0])).toEqual(['acquire', 'acquire', 'acquire', 'bundle', 'deploy'])
    expect(c.slice(0, 3).map((l) => l.split(' ')[1])).toEqual(HOSTS.slice(0, 3))
    // the same contract id on every instance, the moments and the image as asked
    const ids = c.slice(0, 3).map((l) => /-c ([0-9a-f-]{36})/.exec(l)![1])
    expect(new Set(ids).size).toBe(1)
    for (const l of c.slice(0, 3)) expect(l).toMatch(/-m 72 .* -i evernode\/sashimono:test$/)
    expect(c.filter((l) => l.startsWith('SHIM'))).toEqual([])
  }, 90_000)

  it('creates the first as the primary and the others with the primary as their only peer and only UNL entry', () => {
    const w = world()
    expect(w.spread().status).toBe(0)
    const nodes = w.json('keys/evernode-cluster.json').nodes as Instance[]
    expect(w.json(`init-${HOSTS[0]}.json`)).toEqual({ mesh: { peer_discovery: { enabled: false } } })
    for (const host of HOSTS.slice(1, 3)) {
      expect(w.json(`init-${host}.json`)).toEqual({
        mesh: { peer_discovery: { enabled: false }, known_peers: [`${nodes[0].domain}:${nodes[0].peerPort}`] },
        contract: { unl: [nodes[0].pubkey] },
      })
    }
  }, 90_000)

  it('bundles with the whole UNL and every instance as a peer, and uploads to the primary', () => {
    const w = world()
    expect(w.spread().status).toBe(0)
    const nodes = w.json('keys/evernode-cluster.json').nodes as Instance[]
    // evdevkit adds the key it is given to the UNL, so it gets the primary's and the override lists the others
    expect(w.json('override.json')).toEqual({
      contract: { consensus: { roundtime: 3000 }, unl: [nodes[1].pubkey, nodes[2].pubkey] },
      mesh: { known_peers: nodes.map((n) => `${n.domain}:${n.peerPort}`) },
    })
    const [bundle, deploy] = w.calls().slice(3)
    expect(bundle).toBe(`bundle ${w.dist} ${nodes[0].pubkey} /usr/bin/node -a index.js`)
    expect(deploy).toBe(`deploy ${path.join(w.dist, '..', 'bundle', 'bundle.zip')} ${nodes[0].domain} ${nodes[0].userPort}`)
  }, 90_000)

  it('puts the consensus threshold it was given into the bundle, next to the round time, and leaves it alone otherwise', () => {
    const w = world()
    expect(w.spread({ CONSENSUS_PCT: '66' }).status).toBe(0)
    expect(w.json('override.json').contract.consensus).toEqual({ roundtime: 3000, threshold: 66 })
    const plain = world()
    expect(plain.spread().status).toBe(0)
    expect(plain.json('override.json').contract.consensus).toEqual({ roundtime: 3000 })
  }, 90_000)

  it('writes the instance list, one per host, readable by its owner only, and prints no secret', () => {
    const w = world()
    const r = w.spread()
    expect(r.status, r.out).toBe(0)
    const saved = w.json('keys/evernode-cluster.json') as { contractId: string; nodes: Instance[] }
    expect(saved.nodes.map((n) => n.host)).toEqual(HOSTS.slice(0, 3))
    expect(new Set(saved.nodes.map((n) => n.host)).size).toBe(3)
    expect(saved.nodes.every((n) => n.name && n.pubkey && n.domain && n.peerPort && n.userPort)).toBe(true)
    expect(fs.statSync(w.out).mode & 0o777).toBe(0o600)
    const everything = r.out + fs.readFileSync(w.out, 'utf8')
    for (const secret of [TENANT_SECRET, USER_KEY, 'deadbeef00']) expect(everything).not.toContain(secret)
  }, 90_000)

  it('uses only the first hosts of a longer list', () => {
    const w = world({ size: 2 })
    expect(w.spread().status).toBe(0)
    expect(w.calls().filter((l) => l.startsWith('acquire')).map((l) => l.split(' ')[1])).toEqual(HOSTS.slice(0, 2))
  }, 90_000)
})

describe('when a host cannot be leased from', () => {
  it('stops there, leaves the list of what was leased, says how to carry on, and bundles nothing', () => {
    const w = world()
    const r = w.spread({ FAIL_HOST: HOSTS[1] })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/no instance was created on rHostBbbb/)
    expect(r.out).toMatch(/1 of 3 instance\(s\) are leased and listed in .*RESUME=1/)
    expect(w.json('keys/evernode-cluster.json').nodes).toHaveLength(1)
    expect(w.calls().map((l) => l.split(' ')[0])).toEqual(['acquire', 'acquire'])
  }, 90_000)

  it('carries on from the list with RESUME=1: the same contract id, the hosts not yet leased, then the bundle', () => {
    const w = world()
    expect(w.spread({ FAIL_HOST: HOSTS[1] }).status).toBe(1)
    const first = w.json('keys/evernode-cluster.json') as { contractId: string; nodes: Instance[] }
    fs.rmSync(path.join(w.dir, 'calls.log'))
    const r = w.spread({ RESUME: '1' })
    expect(r.status, r.out).toBe(0)
    const c = w.calls()
    expect(c.map((l) => l.split(' ')[0])).toEqual(['acquire', 'acquire', 'bundle', 'deploy'])
    expect(c.slice(0, 2).map((l) => l.split(' ')[1])).toEqual([HOSTS[1], HOSTS[2]])
    for (const l of c.slice(0, 2)) expect(l).toContain(`-c ${first.contractId}`)
    const done = w.json('keys/evernode-cluster.json') as { nodes: Instance[] }
    expect(done.nodes.map((n) => n.host)).toEqual(HOSTS.slice(0, 3))
    expect(done.nodes[0]).toEqual(first.nodes[0]) // the first instance was kept, not leased again
    // and the ones leased now are told about the primary that was leased before
    expect(w.json(`init-${HOSTS[1]}.json`).contract.unl).toEqual([first.nodes[0].pubkey])
  }, 90_000)
})

describe('what it refuses before leasing anything', () => {
  it('fewer hosts than instances', () => {
    const w = world({ hosts: HOSTS.slice(0, 2) })
    const r = w.spread()
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/lists 2 host\(s\) for 3 instances: each instance needs a host of its own/)
    expect(w.calls()).toEqual([])
  })
  it('a host listed twice among the first ones', () => {
    const w = world({ hosts: [HOSTS[0], HOSTS[1], HOSTS[0], HOSTS[2]] })
    const r = w.spread()
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/lists a host twice/)
    expect(w.calls()).toEqual([])
  })
  it('an instance list that already holds a cluster, unless it is being resumed', () => {
    const w = world()
    expect(w.spread().status).toBe(0)
    const again = w.spread()
    expect(again.status).toBe(1)
    expect(again.out).toMatch(/already lists 3 instance\(s\): move it aside for a new cluster, or RESUME=1/)
  }, 90_000)
  it('a number of moments that is not one', () => {
    const w = world()
    expect(w.spread({ MOMENTS: '0' }).status).toBe(1)
    expect(w.spread({ MOMENTS: '5000' }).status).toBe(1)
    expect(w.calls()).toEqual([])
  }, 90_000)
  it('a consensus threshold that is not a whole percent from 51 to 100', () => {
    const w = world()
    for (const bad of ['50', '101', '66.5', 'abc']) {
      const r = w.spread({ CONSENSUS_PCT: bad })
      expect(r.status, bad).toBe(1)
      expect(r.out, bad).toMatch(/CONSENSUS_PCT must be a whole percent from 51 to 100/)
    }
    expect(w.calls()).toEqual([])
  }, 90_000)
})

describe('a dry run', () => {
  it('prints the plan and leases nothing', () => {
    const w = world()
    const r = w.spread({ DRY_RUN: '1' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('3 instance(s), one on each of:')
    expect(r.out.match(/\+ evdevkit acquire /g)).toHaveLength(3)
    expect(r.out).toContain('DRY_RUN=1: nothing was leased or sent.')
    expect(r.out).toContain("consensus threshold left at HotPocket's 80%")
    expect(r.out).toContain('wait until every instance runs the app, is synced and closes ledgers')
    expect(w.calls()).toEqual([])
    expect(fs.existsSync(w.out)).toBe(false)
    expect(w.spread({ DRY_RUN: '1', CONSENSUS_PCT: '66' }).out).toContain('consensus threshold 66%')
  }, 90_000)
})

describe('reading what evdevkit prints', () => {
  const printed = (extra = '') => `\u001b[32mInstance created!\u001b[0m {\n  name: 'ABC123',\n  pubkey: 'ed99',\n  contract_id: 'x',\n  peer_port: '22861',\n  user_port: '26201',\n  domain: 'evernode.example',\n${extra}}\n`
  it('takes the name, key, ports and domain, colours and all', () => {
    expect(parseInstance(printed(), 'rH')).toEqual({ host: 'rH', name: 'ABC123', pubkey: 'ed99', peerPort: 22861, userPort: 26201, domain: 'evernode.example' })
  })
  it('refuses output with no created instance, and says what evdevkit said, without any key', () => {
    expect(() => parseInstance("Error occurred while acquiring the instance: No offers available. privateKey: 'abcdef0123'", 'rH')).toThrow(/no instance was created on rH/)
    try {
      parseInstance("Error occurred: privateKey: 'abcdef0123'", 'rH')
    } catch (e) {
      expect((e as Error).message).not.toContain('abcdef0123')
    }
  })
  it('refuses an instance that came back without a port or key', () => {
    expect(() => parseInstance(`Instance created! {\n  name: 'A',\n  pubkey: 'ed1',\n}`, 'rH')).toThrow(/without a name, key, ports or domain/)
  })
})

describe('the settings it builds', () => {
  const a: Instance = { host: 'rA', name: 'A', pubkey: 'edA', peerPort: 1, userPort: 2, domain: 'a.example' }
  const b: Instance = { host: 'rB', name: 'B', pubkey: 'edB', peerPort: 3, userPort: 4, domain: 'b.example' }
  const c: Instance = { host: 'rC', name: 'C', pubkey: 'edC', peerPort: 5, userPort: 6, domain: 'c.example' }
  it('leave the primary on the base settings and point the others at it', () => {
    const base = { mesh: { peer_discovery: { enabled: false } }, contract: { consensus: { roundtime: 3000 } } }
    expect(initConfigFor(base, null)).toBe(base)
    expect(initConfigFor(base, a)).toEqual({ mesh: { peer_discovery: { enabled: false }, known_peers: ['a.example:1'] }, contract: { consensus: { roundtime: 3000 }, unl: ['edA'] } })
    expect(base.contract).toEqual({ consensus: { roundtime: 3000 } }) // the base itself is not changed
  })
  it('list the others in the UNL and everyone as a peer', () => {
    expect(overrideFor({ contract: { consensus: { roundtime: 3000 } } }, [a, b, c])).toEqual({ contract: { consensus: { roundtime: 3000 }, unl: ['edB', 'edC'] }, mesh: { known_peers: ['a.example:1', 'b.example:3', 'c.example:5'] } })
  })
  it('set the consensus threshold beside the round time when there is one, and without a base for it', () => {
    expect(overrideFor({ contract: { consensus: { roundtime: 3000 } } }, [a, b, c], 66).contract).toEqual({ consensus: { roundtime: 3000, threshold: 66 }, unl: ['edB', 'edC'] })
    expect(overrideFor({}, [a, b, c], 66).contract).toEqual({ consensus: { threshold: 66 }, unl: ['edB', 'edC'] })
    expect(overrideFor({}, [a, b, c]).contract).toEqual({ unl: ['edB', 'edC'] }) // no threshold asked for, none invented
  })
})
