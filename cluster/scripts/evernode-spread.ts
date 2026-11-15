import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { library, offersOf } from './evernode-hosts'
import { sampleNode } from './lib/cluster-client'
import { describeSamples, formationProblems, type NodeSample } from './lib/formation'

/**
 * Leases one instance on each host of a list and starts the cluster on them. Called by scripts/evernode-cluster.sh, which
 * has already checked the placement and loaded the tenant wallet into EV_TENANT_SECRET (never printed here).
 *
 * Why not `evdevkit cluster-create`: it chooses hosts itself, round-robin from the top of the list for each chunk, so on a
 * list of three hosts it put the first node on the first host, the second on the second and the third on the first again
 * (and, when that host had no offer left, on the second): two of three instances with one operator, and the third host never
 * used (the rehearsal of 2026-10-18). Decision 3 says no host operator may run k or more instances, so the placement is made
 * here, one acquire per host, in the order of the list, each host once.
 *
 * What cluster-create does after the leases is done the same way: the first instance is the primary; every other is created
 * with the primary as its only peer and its only UNL entry; once they have had time to start, one bundle goes to the primary
 * with the whole UNL and every peer, and the bootstrap contract on each instance unpacks it.
 *
 * Env: HOSTS (file, one address per line; the first SIZE are used, each once), SIZE, MOMENTS, IMAGE, DIST (the built bundle
 * directory), OUT (the instance list written as it grows, default keys/evernode-cluster.json), RESUME=1 (carry on from OUT),
 * EV_HP_INIT_CFG_PATH and EV_HP_OVERRIDE_CFG_PATH (the base HotPocket settings), CONSENSUS_PCT (HotPocket's consensus threshold
 * in percent, 51 to 100, which evernode-cluster.sh works out from the genesis' k and n: scripts/lib/consensus.ts says why 80 is
 * wrong for three nodes), WAIT_SYNC_S (30), DRY_RUN=1. SKIP_OFFERS_CHECK=1 and SKIP_VERIFY=1 are for tests.
 *
 * The cluster is finished when it has formed, not when the bundle is up: every instance on the built app, its UNL the whole
 * cluster, `synced`, closing ledgers (scripts/lib/formation.ts). A cluster that does not form is reported with each node's
 * state and exit 1; its instances stay leased, since an instance cannot be restarted or repaired from outside.
 */

export interface Instance {
  host: string
  name: string
  pubkey: string
  peerPort: number
  userPort: number
  domain: string
}

export interface Plan {
  hosts: string[]
  moments: number
  image: string
  contractId: string
}

/** How long to wait for a cluster to form after the bundle is up, and how far apart the two looks that are compared must be. */
const FORMATION_TIMEOUT_MS = 5 * 60_000
const MIN_GAP_MS = 9_000

const ANSI = /\x1b\[[0-9;]*m/g
const clean = (text: string) => text.replace(ANSI, '').replace(/(privateKey: ')[0-9a-fA-F]+/g, '$1<masked>')

/** The instance evdevkit prints after "Instance created!". Throws when a field the cluster needs is missing. */
export function parseInstance(output: string, host: string): Instance {
  const text = clean(output)
  const at = text.indexOf('Instance created!')
  if (at < 0) throw new Error(`no instance was created on ${host}:\n${text.trim().split('\n').slice(-6).join('\n')}`)
  const body = text.slice(at)
  const field = (key: string) => new RegExp(`\\b${key}:\\s*'([^']*)'`).exec(body)?.[1]
  const name = field('name')
  const pubkey = field('pubkey')
  const peer = field('peer_port')
  const user = field('user_port')
  const domain = field('domain')
  if (!name || !pubkey || !peer || !user || !domain) throw new Error(`the instance on ${host} came back without a name, key, ports or domain:\n${body.slice(0, 400)}`)
  return { host, name, pubkey, peerPort: Number(peer), userPort: Number(user), domain }
}

/** The settings a non-primary instance is created with: the base, plus the primary as its only peer and only UNL entry. */
export function initConfigFor(base: Record<string, any>, primary: Instance | null): Record<string, any> {
  if (!primary) return base
  return { ...base, mesh: { ...(base.mesh ?? {}), known_peers: [`${primary.domain}:${primary.peerPort}`] }, contract: { ...(base.contract ?? {}), unl: [primary.pubkey] } }
}

/**
 * The override for the bundle. `evdevkit bundle` adds the key it is given to the UNL itself, so it is given the primary's and
 * this lists the others; together that is the whole UNL. Every instance is a known peer. With a `percent`, HotPocket closes a
 * ledger when that share of the UNL agrees (the default, 80, needs all of three nodes).
 */
export function overrideFor(base: Record<string, any>, nodes: Instance[], percent?: number): Record<string, any> {
  const consensus = percent === undefined ? base.contract?.consensus : { ...(base.contract?.consensus ?? {}), threshold: percent }
  return {
    ...base,
    contract: { ...(base.contract ?? {}), ...(consensus ? { consensus } : {}), unl: nodes.slice(1).map((n) => n.pubkey) },
    mesh: { ...(base.mesh ?? {}), known_peers: nodes.map((n) => `${n.domain}:${n.peerPort}`) },
  }
}

const readJson = (file: string | undefined, fallback: Record<string, any>) => (file && fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>) : fallback)

function evdevkit(bin: string, args: string[], env: Record<string, string | undefined>): string {
  const r = spawnSync(bin, args, { env: { ...process.env, ...env } as NodeJS.ProcessEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Error(`could not run ${bin}: ${r.error.message}`)
  // evdevkit exits 0 on failure: the text is the truth.
  return clean(`${r.stdout ?? ''}${r.stderr ?? ''}`)
}

function tmpJson(value: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evspread-'))
  const file = path.join(dir, 'cfg.json')
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
  return file
}

async function main(): Promise<void> {
  const hostsFile = process.env.HOSTS ?? 'hp/hosts.txt'
  const n = Number(process.env.SIZE)
  if (!Number.isInteger(n) || n < 1) throw new Error('SIZE must be the number of instances')
  const moments = Number(process.env.MOMENTS ?? 2)
  if (!Number.isInteger(moments) || moments < 1 || moments > 4320) throw new Error('MOMENTS must be a whole number of hourly moments, 1 to 4320')
  const pct = process.env.CONSENSUS_PCT
  const percent = pct === undefined || pct === '' ? undefined : Number(pct)
  if (percent !== undefined && (!Number.isInteger(percent) || percent < 51 || percent > 100)) throw new Error('CONSENSUS_PCT must be a whole percent from 51 to 100')
  const image = process.env.IMAGE ?? 'evernode/sashimono:hp.0.6.5-beta-ubt.20.04-njs.20'
  const dist = path.resolve(process.env.DIST ?? 'dist')
  const out = path.resolve(process.env.OUT ?? 'keys/evernode-cluster.json')
  const bin = process.env.EVDEVKIT ?? 'evdevkit'
  const dry = process.env.DRY_RUN === '1'
  const hosts = fs.readFileSync(hostsFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(l))
  if (hosts.length < n) throw new Error(`${hostsFile} lists ${hosts.length} host(s) for ${n} instances: each instance needs a host of its own`)
  const use = hosts.slice(0, n)
  if (new Set(use).size !== n) throw new Error(`${hostsFile} lists a host twice among the first ${n}: each instance needs a host of its own`)

  const saved = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, 'utf8')) as { contractId?: string; nodes?: Instance[] }) : null
  const resume = process.env.RESUME === '1'
  if (saved?.nodes?.length && !resume) throw new Error(`${out} already lists ${saved.nodes.length} instance(s): move it aside for a new cluster, or RESUME=1 to carry on creating that one`)
  const nodes: Instance[] = resume && saved?.nodes ? [...saved.nodes] : []
  const contractId = (resume && saved?.contractId) || randomUUID()
  const todo = use.filter((h) => !nodes.some((x) => x.host === h))
  const baseInit = readJson(process.env.EV_HP_INIT_CFG_PATH, {})
  const baseOverride = readJson(process.env.EV_HP_OVERRIDE_CFG_PATH, {})

  console.log(`${n} instance(s), one on each of: ${use.join(', ')}`)
  console.log(`${moments} moment(s) each, image ${image}, contract id ${contractId}${nodes.length ? ` (resuming: ${nodes.length} already leased)` : ''}`)
  if (dry) {
    for (const [i, host] of todo.entries()) console.log(`+ evdevkit acquire ${host} -m ${moments} -c ${contractId} -i ${image}   (${nodes.length + i === 0 ? 'the primary: base settings' : 'peer and UNL: the primary'})`)
    console.log(`+ (wait ${process.env.WAIT_SYNC_S ?? 30} s) evdevkit bundle ${dist} <primary key> /usr/bin/node -a index.js   (override: UNL of the others, every instance as a peer, consensus threshold ${percent === undefined ? 'left at HotPocket\'s 80%' : `${percent}%`})`)
    console.log('+ evdevkit deploy <bundle> <primary domain> <primary user port>')
    console.log('+ wait until every instance runs the app, is synced and closes ledgers (up to 5 minutes)')
    console.log('DRY_RUN=1: nothing was leased or sent.')
    return
  }

  if (!process.env.SKIP_OFFERS_CHECK) {
    const ev = library()
    await ev.Defaults.useNetwork('mainnet')
    for (const host of todo) {
      const offers = await offersOf(ev, host)
      if (offers === 0) throw new Error(`${host} has no lease offer open: nothing is leased yet. Replace it in ${hostsFile} (a host's free-slot count in the registry is not its offers)`)
    }
  }

  const save = () => {
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
    fs.writeFileSync(out, `${JSON.stringify({ contractId, createdAt: new Date().toISOString(), moments, image, nodes }, null, 2)}\n`, { mode: 0o600 })
  }

  for (const host of todo) {
    const primary = nodes[0] ?? null
    const initPath = tmpJson(initConfigFor(baseInit, primary))
    console.log(`== instance ${nodes.length + 1} of ${n} on ${host}`)
    const text = evdevkit(bin, ['acquire', host, '-m', String(moments), '-c', contractId, '-i', image], { EV_HP_INIT_CFG_PATH: initPath })
    let instance: Instance
    try {
      instance = parseInstance(text, host)
    } catch (e) {
      save()
      throw new Error(`${(e as Error).message}\n${nodes.length} of ${n} instance(s) are leased and listed in ${out}; fix the cause and run again with RESUME=1`)
    }
    nodes.push(instance)
    save()
    console.log(`   ${instance.name.slice(0, 12)}…  ${instance.domain}:${instance.userPort} (peers ${instance.peerPort})`)
  }

  console.log(`== waiting ${process.env.WAIT_SYNC_S ?? 30} s for the instances to start`)
  await new Promise((r) => setTimeout(r, Number(process.env.WAIT_SYNC_S ?? 30) * 1000))

  console.log('== bundle for the whole cluster')
  const bundleOut = evdevkit(bin, ['bundle', dist, nodes[0].pubkey, '/usr/bin/node', '-a', 'index.js'], { EV_HP_OVERRIDE_CFG_PATH: tmpJson(overrideFor(baseOverride, nodes, percent)) })
  if (!/Archive finished/.test(bundleOut)) throw new Error(`the bundle was not made:\n${bundleOut.trim().split('\n').slice(-6).join('\n')}`)
  const zip = path.join(dist, '..', 'bundle', 'bundle.zip')

  console.log(`== upload to the primary ${nodes[0].domain}:${nodes[0].userPort}`)
  const deployOut = evdevkit(bin, ['deploy', zip, nodes[0].domain, String(nodes[0].userPort)], {})
  if (!/Contract bundle uploaded/.test(deployOut)) throw new Error(`the bundle was not uploaded (the instances stay leased; "evdevkit deploy ${zip} ${nodes[0].domain} ${nodes[0].userPort}" tries again):\n${deployOut.trim().split('\n').slice(-6).join('\n')}`)

  if (process.env.SKIP_VERIFY) return console.log('cluster created (not verified: SKIP_VERIFY)')
  const want = createHash('sha256').update(fs.readFileSync(path.join(dist, 'app.js'))).digest('hex')
  const addrs = nodes.map((x) => `${x.domain}:${x.userPort}`)
  console.log('== waiting for the cluster to form: every instance on the app, synced and closing ledgers')
  const deadline = Date.now() + FORMATION_TIMEOUT_MS
  const looks: { at: number; samples: NodeSample[] }[] = []
  let problems: string[] = ['no instance has been looked at']
  while (Date.now() < deadline) {
    const samples = await Promise.all(addrs.map(sampleNode))
    const at = Date.now()
    // compare with the newest look that is old enough for the ledgers to have moved
    const before = [...looks].reverse().find((l) => at - l.at >= MIN_GAP_MS)
    if (before) {
      problems = formationProblems(before.samples, samples, { appHash: want, unl: nodes.length, gapMs: at - before.at })
      if (!problems.length) {
        console.log(describeSamples(samples))
        console.log(`cluster formed: ${nodes.length} instance(s) run app ${want.slice(0, 12)}, one per host, all synced and closing ledgers`)
        return
      }
    }
    looks.push({ at, samples })
    if (looks.length > 12) looks.shift()
    await new Promise((r) => setTimeout(r, 5_000))
  }
  const last = looks[looks.length - 1]?.samples ?? []
  throw new Error(
    `the bundle was uploaded and the ${nodes.length} instances are leased, but the cluster did not form in ${FORMATION_TIMEOUT_MS / 60_000} minutes:\n${problems.map((p) => `  - ${p}`).join('\n')}\n${describeSamples(last)}\n` +
      'An instance cannot be restarted or repaired from outside, so a cluster that is stuck stays stuck until its leases end: look again with ' +
      `"npx tsx scripts/cluster-health.ts --file ${out}" and, if it does not recover, lease a new cluster (docs/DESIGN.md, Decision 39)`,
  )
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('ERROR', e?.message ?? e)
      process.exit(1)
    })
}
