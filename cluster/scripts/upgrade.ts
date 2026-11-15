import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import HotPocket from 'hotpocket-js-client'
import { MAX_GZ_BYTES, compileProblem, sha256 } from '../src/upgrade'
import { connect, readCode, type CodeRead } from './lib/cluster-client'

/**
 * Changes the code of a running cluster (src/loader-core.ts, docs/BRIDGE_UPGRADES.md). The new code is dist/app.js from
 * `npm run build`; the key is an upgrader key from the genesis (`admin.ts keygen --key keys/upgrade.json` makes one; keep it
 * like a node key, because whoever holds it can replace the code that guards every locked token).
 *
 *   npx tsx scripts/upgrade.ts hash   [--app dist/app.js]          # what would be pushed: size and SHA-256
 *   npx tsx scripts/upgrade.ts status --node host:port[,host:port…] # each node's version, hashes, whether the app loads; "agree" or "DIFFER"
 *   npx tsx scripts/upgrade.ts push   --node host:port [--app dist/app.js] [--key keys/upgrade.json] [--dry-run] [--force]
 *   npx tsx scripts/upgrade.ts rollback --node host:port [--key …]  # swap back to the previous version
 *   npx tsx scripts/upgrade.ts keys   --node host:port --upgraders ed…,ed… [--key …]  # replace the list of upgrader keys
 *
 * --node is a node's user port (an Evernode instance's `domain:user port`) or the front door. An upgrade is a consensus
 * input: every node installs it in the same round and runs the new code from that round on, so check `status` afterwards.
 */
HotPocket.setLogLevel(2)

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string) => args.includes(`--${name}`)
const cmd = args[0]
const APP_FILE = path.resolve(flag('app') ?? path.join(__dirname, '..', 'dist', 'app.js'))
const KEY_FILE = path.resolve(flag('key') ?? path.join(__dirname, '..', 'keys', 'upgrade.json'))
/** How long to wait for the cluster to record what became of a message. */
const OUTCOME_TIMEOUT_MS = 60_000

/**
 * Sends one upgrade message as the upgrader and returns what the cluster recorded for it. The loader sends no answer (an
 * output is compared across nodes, and one node out of step in that round stalls the cluster): the outcome is written into
 * its state, under the request id, and read back with a `code` read.
 */
async function send(node: string, body: Record<string, unknown>): Promise<NonNullable<CodeRead['last']>> {
  if (!fs.existsSync(KEY_FILE)) throw new Error(`${KEY_FILE} does not exist: make one with "npx tsx scripts/admin.ts keygen --key ${KEY_FILE}" and list its public key as an upgrader in the genesis`)
  const file = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) as { privateKeyHex: string }
  const client = await connect(node, await HotPocket.generateKeys(file.privateKeyHex))
  const id = `upgrade-${Date.now()}`
  try {
    const sub = await client.submitContractInput(JSON.stringify({ type: 'upgrade', id, ...body }))
    const status = await sub.submissionStatus
    if (status.status !== 'accepted') throw new Error(`the node rejected the input: ${status.reason}`)
  } finally {
    await client.close()
  }
  const deadline = Date.now() + OUTCOME_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500))
    const read = await readCode(node).catch(() => null)
    if (read?.last?.id === id) return read.last
  }
  throw new Error(`nothing recorded for this request in ${OUTCOME_TIMEOUT_MS / 1000} s: the key may not be an upgrader, or the cluster is not closing ledgers; check "status"`)
}

function packApp(): { code: Buffer; gz: Buffer; hash: string } {
  if (!fs.existsSync(APP_FILE)) throw new Error(`${APP_FILE} does not exist: run npm run build first`)
  const code = fs.readFileSync(APP_FILE)
  const problem = compileProblem(code.toString('utf8'))
  if (problem) throw new Error(`${APP_FILE} does not compile: ${problem}`)
  const gz = gzipSync(code, { level: 9 })
  if (gz.length > MAX_GZ_BYTES) throw new Error(`${APP_FILE} is ${gz.length} bytes compressed; an upgrade may carry ${MAX_GZ_BYTES}`)
  return { code, gz, hash: sha256(code) }
}

const short = (h: string | null) => (h ? h.slice(0, 12) : '-')

async function status(): Promise<void> {
  const nodes = (flag('node') ?? process.env.BRIDGE_NODE ?? '').split(',').map((n) => n.trim()).filter(Boolean)
  if (!nodes.length) throw new Error('--node host:port[,host:port…] is required')
  const reads: CodeRead[] = []
  for (const node of nodes) {
    try {
      const r = await readCode(node)
      reads.push(r)
      console.log(`  ${node.padEnd(34)} version ${String(r.version).padEnd(3)} hash ${short(r.hash)}  app.js ${short(r.appHash)}  prev ${short(r.prevHash)}  loaded ${r.loaded}${r.error ? `  ERROR ${r.error}` : ''}`)
    } catch (e) {
      console.log(`  ${node.padEnd(34)} ${(e as Error).message}`)
    }
  }
  if (reads.length) {
    const one = new Set(reads.map((r) => `${r.version}:${r.hash}:${r.appHash}`)).size === 1
    console.log(one && reads.length === nodes.length ? `\nall ${reads.length} node(s) agree` : `\nDIFFER or unreachable: ${reads.length} of ${nodes.length} answered${one ? ' (those agree)' : ''}`)
    console.log(`upgrader key(s): ${reads[0].upgraders.map((k) => `${k.slice(0, 12)}…`).join(', ') || 'none (the code can never change)'}`)
  }
}

async function main(): Promise<void> {
  if (cmd === 'hash') {
    const { code, gz, hash } = packApp()
    console.log(`${APP_FILE}\n  ${code.length} bytes, ${gz.length} gzipped, sha256 ${hash}`)
    return
  }
  if (cmd === 'status') return status()
  const node = flag('node') ?? process.env.BRIDGE_NODE
  if (!node) throw new Error('--node host:port (or BRIDGE_NODE) is required')
  const before = await readCode(node)
  if (before.version === null) throw new Error(`${node} reports no upgrade state: ${before.error}`)
  const version = before.version + 1

  let body: Record<string, unknown>
  if (cmd === 'push') {
    const { code, gz, hash } = packApp()
    console.log(`pushing ${APP_FILE}: ${code.length} bytes, ${gz.length} gzipped, sha256 ${hash.slice(0, 16)}…  (cluster is at version ${before.version}, running ${short(before.appHash)})`)
    if (before.appHash === hash && !has('force')) throw new Error('the cluster already runs exactly this code (--force to push it anyway)')
    if (has('dry-run')) return console.log('--dry-run: nothing sent')
    body = { op: 'code', version, hash, gz: gz.toString('base64') }
  } else if (cmd === 'rollback') {
    if (!before.prevHash) throw new Error('the cluster has no previous version to go back to')
    console.log(`rolling back from ${short(before.appHash)} to ${short(before.prevHash)}`)
    if (has('dry-run')) return console.log('--dry-run: nothing sent')
    body = { op: 'rollback', version }
  } else if (cmd === 'keys') {
    const upgraders = (flag('upgraders') ?? '').split(',').map((k) => k.trim()).filter(Boolean)
    console.log(`replacing the upgrader keys (${before.upgraders.length} now) with ${upgraders.length}: ${upgraders.map((k) => `${k.slice(0, 12)}…`).join(', ')}`)
    if (has('dry-run')) return console.log('--dry-run: nothing sent')
    body = { op: 'keys', version, upgraders }
  } else {
    console.log('usage: npx tsx scripts/upgrade.ts hash | status --node … | push --node … | rollback --node … | keys --node … --upgraders ed…,ed…')
    process.exit(1)
  }

  const result = await send(node, body)
  if (!result.ok) throw new Error(`refused: ${result.error}`)
  const after = await readCode(node)
  console.log(`accepted. ${node} now reports version ${after.version}, app.js ${short(after.appHash)}, loaded ${after.loaded}${after.error ? `, ERROR ${after.error}` : ''}`)
  console.log('check every node with: npx tsx scripts/upgrade.ts status --node <all of them>')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR', e?.message ?? e)
    process.exit(1)
  })
