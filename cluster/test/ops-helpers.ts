/**
 * Test scaffolding for the ops scripts (scripts/*.sh, scripts/remote/*.sh). Nothing here touches a host: the remote halves
 * are run against a fake hpdevkit volume in a temp directory with a docker test double, and the orchestrators run only
 * in DRY_RUN with ssh/rsync/npm/docker replaced by doubles that fail the test if they are ever called.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PKG = path.resolve(__dirname, '..')

const made: string[] = []
export function tmpDir(prefix = 'ops-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}
export function cleanupTmp(): void {
  for (const dir of made.splice(0)) {
    // A test may leave a directory read-only on purpose.
    spawnSync('chmod', ['-R', 'u+rwx', dir])
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export interface Ran {
  status: number | null
  stdout: string
  stderr: string
  /** stdout and stderr together, for assertions about what an operator would see. */
  out: string
}

export function run(cmd: string, args: string[], opts: { env?: Record<string, string | undefined>; cwd?: string; input?: string | Buffer } = {}): Ran {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) if (v !== undefined) env[k] = v
  const r = spawnSync(cmd, args, { env, cwd: opts.cwd ?? PKG, input: opts.input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Like run(), for a test that serves the child from its own process: spawnSync would block the very event loop that answers it. */
export function runAsync(cmd: string, args: string[], opts: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<Ran> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) if (v !== undefined) env[k] = v
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd: opts.cwd ?? PKG })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr }))
  })
}

/** What a dummy key file looks like, with markers that must never appear in anything an operator reads. */
export function dummyKeys(n: number) {
  return {
    xrpl: { seed: `sDUMMYSEED${n}xxxxxxxxxxxxxxxxxxxxxxxx`, address: `rDummyNode${n}Address`, publicKey: `PUBKEY${n}` },
    evm: { privateKey: `0xDUMMYPRIVATEKEY${n}`, address: `0xdummynode${n}address` },
    createdAt: 1_700_000_000_000 + n,
  }
}
export const SECRET_MARKERS = ['DUMMYSEED', 'DUMMYPRIVATEKEY']

export interface FakeVolume {
  /** hpdevkit_<cluster>_vol/_data */
  vol: string
  /** the directory that holds hpdevkit_<cluster>_vol */
  volRoot: string
  seedDir(n: number): string
}

/** A volume the way hpdevkit lays one out: node<N>/contract_fs/seed/{bridge-keys.json,bridge-payout.json,state/*.json}. */
/** The params of the dev genesis: the cluster refuses to run a config without a complete, valid set (configProblems), and the snapshot tools load the state the same way. */
export const DEV_PARAMS = JSON.parse(fs.readFileSync(path.join(PKG, 'genesis/dev.json'), 'utf8')).config.params as Record<string, unknown>

export function makeVolume(root: string, cluster: string, opts: { nodes: number; keys?: number[]; payout?: number[]; config?: Record<string, unknown> }): FakeVolume {
  const volRoot = path.join(root, 'volumes')
  const vol = path.join(volRoot, `hpdevkit_${cluster}_vol`, '_data')
  const config = opts.config ?? { k: Math.floor(opts.nodes / 2) + 1, n: opts.nodes, feed: 'fake', params: DEV_PARAMS, intentTtlMs: 1, xrpl: { rpc: ['https://testnet.xrpl-labs.com/'], lockAccount: 'rLock', fundingAccount: 'rFund' } }
  for (let n = 1; n <= opts.nodes; n++) {
    const seed = path.join(vol, `node${n}`, 'contract_fs', 'seed')
    fs.mkdirSync(path.join(seed, 'state'), { recursive: true })
    fs.writeFileSync(path.join(seed, 'state', 'config.json'), JSON.stringify(config))
    fs.writeFileSync(path.join(seed, 'state', 'cursor.json'), JSON.stringify({ xrpl: { ledger: 1000 + n, seen: [] } }))
    fs.writeFileSync(path.join(seed, 'state', 'tokens.json'), '{}')
    if ((opts.keys ?? []).includes(n)) fs.writeFileSync(path.join(seed, 'bridge-keys.json'), JSON.stringify(dummyKeys(n)), { mode: 0o600 })
    if ((opts.payout ?? []).includes(n)) fs.writeFileSync(path.join(seed, 'bridge-payout.json'), JSON.stringify({ address: `rPayout${n}Address` }), { mode: 0o600 })
  }
  return { vol, volRoot, seedDir: (n) => path.join(vol, `node${n}`, 'contract_fs', 'seed') }
}

/**
 * A docker double. It logs every call to $STUB_LOG and does what the ops scripts need of docker:
 *   exec <mgr> cluster stop|start|status|bindmesh|destroy   no-ops, and `sync` wipes contract_fs/* of every node like the real manager
 *   ps                                                      prints a container id when STUB_RUNNING is set, names from STUB_CONTAINERS for --format
 *   inspect hpdevkit_default_deploymgr                      a manager environment; any other name prints a writable-layer dir under $STUB_UPPER
 *   volume rm <name>                                        removes that directory under $STUB_VOLROOT
 *   run, rm, network                                        logged
 * Knobs: STUB_SYNC=fail makes `cluster sync` wipe and then fail; STUB_BREAK_NODE=<n> makes that node's seed dir read-only after the sync.
 */
export function writeDockerStub(dir: string): string {
  const file = path.join(dir, 'docker')
  fs.writeFileSync(
    file,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${STUB_LOG:?}"
case "$1" in
  exec)
    shift 2
    case "$1 \${2:-}" in
      "cluster sync")
        for d in "\${STUB_VOL:?}"/node*; do
          rm -rf "$d"/contract_fs/*
          mkdir -p "$d/contract_fs/seed/state"
        done
        if [ "\${STUB_SYNC:-ok}" = fail ]; then echo "sync exploded" >&2; exit 1; fi
        if [ -n "\${STUB_BREAK_NODE:-}" ]; then chmod 500 "$STUB_VOL/node$STUB_BREAK_NODE/contract_fs/seed"; fi
        exit 0 ;;
      sh*) echo "  (none yet)"; exit 0 ;;
      *) exit 0 ;;
    esac ;;
  ps)
    case "$*" in
      *--format*) for c in \${STUB_CONTAINERS:-}; do echo "$c"; done ;;
      *) if [ -n "\${STUB_RUNNING:-}" ]; then echo abc123def456; fi ;;
    esac
    exit 0 ;;
  inspect)
    if [ "$2" = hpdevkit_default_deploymgr ]; then
      printf 'PATH=/usr/bin\\nCLUSTER=default\\nCLUSTER_SIZE=3\\nVOLUME=hpdevkit_default_vol\\nNETWORK=hpdevkit_default_net\\nCONTAINER_PREFIX=hpdevkit_default_node_\\nHP_USER_PORT_BEGIN=8081\\nHP_PEER_PORT_BEGIN=22861\\n'
    else
      echo "\${STUB_UPPER:?}/$2"
    fi
    exit 0 ;;
  logs) echo "Ledger created (lcl 12-abcdef)"; exit 0 ;;
  volume)
    if [ "$2" = rm ]; then rm -rf "\${STUB_VOLROOT:?}/$3"; fi
    exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  )
  return file
}

/** Doubles that fail loudly if a dry run ever reaches for the network or a host. */
export function writeForbiddenStubs(dir: string, names: string[]): void {
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "\${STUB_LOG:?}"\necho "${name} must not be called in a dry run" >&2\nexit 99\n`, { mode: 0o755 })
  }
}

/** A copy of scripts/ in a sandbox package root with fixture genesis files, so an orchestrator's `cd` lands somewhere harmless. */
export function makeSandbox(root: string, genesis: Record<string, unknown>): string {
  const dir = path.join(root, 'pkg')
  fs.mkdirSync(path.join(dir, 'genesis'), { recursive: true })
  fs.cpSync(path.join(PKG, 'scripts'), path.join(dir, 'scripts'), { recursive: true })
  fs.symlinkSync(path.join(PKG, 'node_modules'), path.join(dir, 'node_modules'))
  fs.copyFileSync(path.join(PKG, 'package.json'), path.join(dir, 'package.json'))
  for (const [name, doc] of Object.entries(genesis)) fs.writeFileSync(path.join(dir, 'genesis', `${name}.json`), JSON.stringify(doc))
  return dir
}

/** A genesis with the fields the ops scripts read. */
export function fakeGenesis(opts: { n: number; k: number; mainnet?: boolean; feed?: 'fake' | 'xrpl' }) {
  return {
    config: {
      k: opts.k,
      n: opts.n,
      feed: opts.feed ?? (opts.mainnet ? 'xrpl' : 'fake'),
      xrpl: { rpc: opts.mainnet ? ['https://xrplcluster.com/', 'https://s1.ripple.com:51234/'] : ['https://testnet.xrpl-labs.com/'], lockAccount: 'rLock', fundingAccount: 'rFund' },
      ...(opts.mainnet ? { evm: { rpc: ['https://rpc.xrplevm.org'], chainId: 1440000, minter: '0x0000000000000000000000000000000000000001' } } : {}),
    },
    tokens: {},
    rounds: {},
    cursor: { xrpl: { ledger: 1, seen: [] } },
  }
}
