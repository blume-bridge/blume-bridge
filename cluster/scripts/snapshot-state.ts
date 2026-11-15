/**
 * Assembles genesis/snapshot.json from the nodes' state directories that
 * snapshot-state.sh pulled into <stage>/node<N>/contract_fs/seed/state. How many
 * nodes there are comes from CLUSTER_SIZE or from the directories pulled, and the
 * state's own config.n must agree. The nodes' files are compared byte for byte:
 * they must all agree, or at least SNAPSHOT_MIN_AGREE of them (never fewer than
 * k), and the dissenters are named. CONFIG_FROM=<genesis file> swaps the config
 * in, for a redeploy that also changes RPCs, params or the minter; it may not
 * change who the operators are (n, k, the accounts).
 *
 *   npx tsx scripts/snapshot-state.ts .snapshot
 *   SNAPSHOT_OUT=/tmp/snapshot.json    where to write (default genesis/snapshot.json)
 *
 * STATE_FROM=<dir> takes the state from an off-box copy instead (a generation that
 * scripts/state-backup.sh wrote, checked against its MANIFEST.json): the way back
 * from a lost box. There is no stage then, no comparison between nodes, and
 * nothing in it is newer than the copy: run scripts/reconcile-snapshot.ts on the
 * result before booting from it.
 *
 * CLEAR_OPERATORS=1 empties the operator set in the snapshot, so the nodes that boot
 * from it vote their keys again (under whatever node identities the new cluster has,
 * with whatever bridge keys are in their key files). A restored box needs it; so does
 * replacing one node's bridge key. It does not touch the SignerList or the minter.
 *
 * The state is read with the cluster's own loader (src/state.ts), so a state file a
 * later version adds is carried over without this script learning its name.
 */
import fs from 'node:fs'
import path from 'node:path'
import { canon } from '../src/canon'
import { loadState } from '../src/state'
import type { State } from '../src/types'
import { chooseSnapshot, digestOf, expectedNodes, minAgreeFrom, verifyManifest, type PulledNode } from './snapshot-plan'

const stateDirOf = (stage: string, n: number) => path.join(stage, `node${n}`, 'contract_fs', 'seed', 'state')

function jsonFiles(dir: string): Record<string, Buffer> {
  if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist`)
  const out: Record<string, Buffer> = {}
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) out[name] = fs.readFileSync(path.join(dir, name))
  return out
}

/** The cluster's own loader reads relative to the working directory, which for a contract is its state directory. */
function loadStateFrom(dir: string): State {
  if (!fs.existsSync(path.join(dir, 'config.json'))) throw new Error(`${dir}: no config.json (the cluster never ran this bundle?)`)
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return loadState().state
  } catch (e) {
    throw new Error(`${dir}: ${(e as Error).message} (an incomplete state directory?)`)
  } finally {
    process.chdir(previous)
  }
}

/** The state of a live cluster, pulled node by node into a stage. */
function fromStage(stage: string): State {
  const nodes = expectedNodes(fs.readdirSync(stage), process.env.CLUSTER_SIZE)
  const pulled: PulledNode[] = nodes.map((n) => ({ n, digest: digestOf(jsonFiles(stateDirOf(stage, n))) }))
  const states = new Map(nodes.map((n) => [n, loadStateFrom(stateDirOf(stage, n))]))
  for (const { n, digest } of pulled) {
    const s = states.get(n)!
    console.log(`  node ${n}: state ${digest.slice(0, 12)} cursor ${s.cursor.xrpl.ledger} evm ${s.cursor.evm?.block ?? '-'}`)
  }
  const first = states.get(nodes[0])!
  const minAgree = minAgreeFrom(process.env.SNAPSHOT_MIN_AGREE, nodes.length, first.config.k)
  const { chosen, dissent } = chooseSnapshot(pulled, minAgree)
  if (dissent.length) console.log(`  WARNING: node ${dissent.join(', ')} hold different state and are left out; the snapshot is node ${chosen[0]}'s, which node ${chosen.join(', ')} agree on`)
  const snapshot = states.get(chosen[0])!
  if (snapshot.config.n !== nodes.length) throw new Error(`the state says n=${snapshot.config.n} but ${nodes.length} node(s) were pulled: CLUSTER_SIZE or the cluster is wrong`)
  return snapshot
}

/** The state of an off-box copy: one directory, checked against the manifest the backup wrote beside it. */
function fromBackup(dir: string): State {
  const files = jsonFiles(dir)
  const manifestFile = path.join(dir, 'MANIFEST.json')
  if (!fs.existsSync(manifestFile)) throw new Error(`${dir} has no MANIFEST.json: it is not a generation written by scripts/state-backup.sh`)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { createdAt?: string; cluster?: string; xrplCursor?: number; files?: Record<string, string> }
  const problems = verifyManifest(files, manifest)
  if (problems.length) throw new Error(`${dir} does not match its manifest:\n    ${problems.join('\n    ')}`)
  const state = loadStateFrom(dir)
  console.log(`  state from the backup copy ${path.basename(path.resolve(dir))}: taken ${manifest.createdAt ?? '?'}, cursor ${state.cursor.xrpl.ledger} evm ${state.cursor.evm?.block ?? '-'}; every file matches its manifest`)
  console.log('  Nothing in it is newer than that. Run scripts/reconcile-snapshot.ts before booting from it.')
  return state
}

function main() {
  const backup = process.env.STATE_FROM
  const stage = process.argv[2]
  if (!backup && !stage) throw new Error('usage: snapshot-state.ts <stage dir>   or   STATE_FROM=<state backup generation> snapshot-state.ts')
  if (backup && stage) throw new Error('give either a stage dir or STATE_FROM, not both')
  const snapshot = backup ? fromBackup(backup) : fromStage(stage)

  if (process.env.CONFIG_FROM) {
    const from = JSON.parse(fs.readFileSync(process.env.CONFIG_FROM, 'utf8')) as { config: State['config'] }
    if (from.config.xrpl.lockAccount !== snapshot.config.xrpl.lockAccount || from.config.xrpl.fundingAccount !== snapshot.config.xrpl.fundingAccount) throw new Error(`${process.env.CONFIG_FROM} names different accounts; that is a fresh genesis, not a snapshot`)
    if (from.config.n !== snapshot.config.n || from.config.k !== snapshot.config.k) throw new Error(`${process.env.CONFIG_FROM} has n=${from.config.n} k=${from.config.k} but the state has n=${snapshot.config.n} k=${snapshot.config.k}. Changing who the operators are is a membership change (SignerList, minter), not a config refresh.`)
    snapshot.config = from.config
    console.log(`  config taken from ${process.env.CONFIG_FROM}`)
  }
  if (process.env.CLEAR_OPERATORS === '1') {
    snapshot.operators = {}
    console.log('  operator set cleared: the nodes will vote their keys again when they boot')
  } else if (process.env.CLEAR_OPERATORS !== undefined && process.env.CLEAR_OPERATORS !== '' && process.env.CLEAR_OPERATORS !== '0') throw new Error('CLEAR_OPERATORS must be 1 or unset')
  const out = process.env.SNAPSHOT_OUT ?? path.join(__dirname, '..', 'genesis', 'snapshot.json')
  fs.writeFileSync(out, canon(snapshot) + '\n')
  const counts = `${Object.keys(snapshot.transfers).length} transfers, ${Object.keys(snapshot.actions).length} actions, ${Object.keys(snapshot.evmActions).length} evm actions, ${Object.keys(snapshot.operators).length} operators`
  console.log(`  ${path.relative(process.cwd(), out)} written: n=${snapshot.config.n} k=${snapshot.config.k}, cursor ${snapshot.cursor.xrpl.ledger}, evm ${snapshot.cursor.evm?.block ?? '-'}, ${counts}`)
}

try {
  main()
} catch (e) {
  console.error('ERROR', (e as Error).message)
  process.exit(1)
}
