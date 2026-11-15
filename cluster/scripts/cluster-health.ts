import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import HotPocket from 'hotpocket-js-client'
import { sampleNode } from './lib/cluster-client'
import { describeSamples, formationProblems } from './lib/formation'

/**
 * Is a cluster closing ledgers? Read-only and key-less: asks every node twice, a few seconds apart, what its loader runs
 * (a `code` read) and what HotPocket says of it (ledger, vote status, UNL), and judges the two looks with the rule that decides
 * whether a new cluster has formed (scripts/lib/formation.ts). Exit 0 when it has, 1 when it has not.
 *
 *   npx tsx scripts/cluster-health.ts --file keys/evernode-cluster.json      # the instances evernode-cluster.sh wrote
 *   npx tsx scripts/cluster-health.ts --node host:port,host:port,host:port   # a node's user port, or the Evernode instance's domain:user port
 *     [--app dist/app.js]   the app that should be running (default dist/app.js when it exists, else what the first node runs)
 *     [--unl 3]             the number of nodes the cluster should have (default: the number listed)
 *     [--gap 10]            seconds between the two looks (default 10)
 */
HotPocket.setLogLevel(2)

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(): Promise<number> {
  const file = flag('file')
  let nodes: string[]
  if (file) {
    const saved = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as { nodes?: { domain: string; userPort: number }[] }
    nodes = (saved.nodes ?? []).map((n) => `${n.domain}:${n.userPort}`)
  } else {
    nodes = (flag('node') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (!nodes.length) throw new Error('usage: cluster-health.ts --file keys/evernode-cluster.json | --node host:port[,host:port…]')
  const gapMs = Number(flag('gap') ?? 10) * 1000
  const unl = Number(flag('unl') ?? nodes.length)

  const first = await Promise.all(nodes.map(sampleNode))
  await new Promise((r) => setTimeout(r, gapMs))
  const second = await Promise.all(nodes.map(sampleNode))

  const appFile = flag('app') ?? (fs.existsSync(path.join(__dirname, '..', 'dist', 'app.js')) ? path.join(__dirname, '..', 'dist', 'app.js') : undefined)
  const appHash = appFile ? createHash('sha256').update(fs.readFileSync(path.resolve(appFile))).digest('hex') : (second.find((s) => s.code?.appHash)?.code?.appHash ?? '')

  const problems = formationProblems(first, second, { appHash, unl, gapMs })
  console.log(describeSamples(second))
  if (problems.length) {
    console.log('\nNOT FORMED:')
    for (const p of problems) console.log(`  - ${p}`)
    return 1
  }
  console.log(`\nformed: ${nodes.length} node(s) on app ${appHash.slice(0, 12)}, all synced and closing ledgers`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('ERROR', e?.message ?? e)
    process.exit(2)
  })
