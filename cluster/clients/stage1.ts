/**
 * End-to-end test of a dev cluster. Runs ON the dev box (needs docker + the three
 * node ports on localhost). Talks to every node over WebSocket, feeds the
 * pretend ledger into each container, and checks that:
 *   1. three nodes agree on a simulated fee and a simulated lock,
 *   2. the lock mints the whole amount (nothing comes out of the token),
 *   3. a read from any node returns the same state,
 *   4. a node that lies (extra event) is outvoted,
 *   5. a node that is slow (broadcasts after the vote timeout) converges,
 *   6. a lock that names no intent is recorded, not minted.
 *
 *   node client/index.js [node1,node2,node3] [genesisPath]
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import HotPocket from 'hotpocket-js-client'

HotPocket.setLogLevel(2)

const NODES = (process.argv[2] ?? 'localhost:8081,localhost:8082,localhost:8083').split(',')
const CONTAINERS = ['hpdevkit_default_node_1', 'hpdevkit_default_node_2', 'hpdevkit_default_node_3']
const GENESIS_PATH = process.argv[3] ?? path.join(__dirname, '..', 'dist', 'genesis.json')
const genesis = JSON.parse(fs.readFileSync(GENESIS_PATH, 'utf8'))
const LOCK = genesis.config.xrpl.lockAccount
const FUND = genesis.config.xrpl.fundingAccount
const W = genesis.config.xrpl.windowLedgers
const PETAL = genesis.tokens.PETAL
const ALICE = 'rJfqVsXN3i6AD9ErSdNo98cyoKw6Euxj8K'
const BOB = 'rpXzhnkZN2JArdmWAk3tmrtJwsErv963Na'
const EVM = '0x5b7e0c3d1a9f4e2b8d6c7a1e3f5b9d2c4e6a8f1c'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const ok = (cond: unknown, msg: string) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}

interface Node {
  target: string
  client: any
  outputs: any[]
  waiters: (() => void)[]
}

async function connect(target: string): Promise<Node> {
  const keys = await HotPocket.generateKeys()
  const client = await HotPocket.createClient([`wss://${target}`], keys)
  if (!(await client.connect())) throw new Error(`cannot connect to ${target}`)
  const node: Node = { target, client, outputs: [], waiters: [] }
  client.on(HotPocket.events.contractOutput, (r: any) => {
    for (const o of r.outputs) {
      node.outputs.push({ output: o, ledger: r.ledgerSeqNo })
      node.waiters.shift()?.()
    }
  })
  return node
}

async function read(node: Node, msg: Record<string, unknown>): Promise<any> {
  return node.client.submitContractReadRequest(JSON.stringify(msg))
}

async function input(node: Node, msg: Record<string, unknown>, timeoutMs = 20000): Promise<any> {
  const submission = await node.client.submitContractInput(JSON.stringify(msg))
  const status = await submission.submissionStatus
  if (status.status !== 'accepted') throw new Error(`input rejected: ${status.reason}`)
  if (node.outputs.length) return node.outputs.shift()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no output within timeout')), timeoutMs)
    node.waiters.push(() => {
      clearTimeout(timer)
      resolve(node.outputs.shift())
    })
  })
}

function feed(container: string, chain: unknown) {
  execSync(`docker exec -i ${container} sh -c 'cat > /tmp/bridge-feed.json'`, { input: JSON.stringify(chain) })
}
function setDelay(container: string, ms: number | null) {
  execSync(`docker exec -i ${container} sh -c '${ms === null ? 'rm -f /tmp/bridge-delay-ms' : `echo ${ms} > /tmp/bridge-delay-ms`}'`)
}
function hpcoreLines(container: string, sinceIso: string): string[] {
  const out = execSync(`docker logs --since ${sinceIso} ${container} 2>&1 | grep -Ei "fork|not on the consensus|state sync|history|desync|Not enough peers" | tail -5 || true`).toString()
  return out.split('\n').filter(Boolean)
}

async function pollUntil<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 45000): Promise<T | null> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const v = await fn()
    if (v) return v
    await sleep(1000)
  }
  console.log(`  ...  ${label}: timed out after ${timeoutMs}ms`)
  return null
}

async function statuses(nodes: Node[]) {
  return Promise.all(nodes.map((n) => read(n, { type: 'status' })))
}

let seq = 0
function payment(to: string, amount: unknown, memo: string | null, ledger: number, from = ALICE) {
  seq++
  return { kind: 'payment', tx: `FAKE${String(seq).padStart(4, '0')}${Date.now().toString(36).toUpperCase()}`, ledger, from, to, amount, memo }
}

async function main() {
  const startedIso = new Date().toISOString()
  console.log(`Dev cluster test against ${NODES.join(', ')}  (genesis ${GENESIS_PATH}, feed=${genesis.config.feed}, k=${genesis.config.k}, n=${genesis.config.n})`)
  const nodes: Node[] = []
  for (const target of NODES) nodes.push(await connect(target))

  console.log('\n1. Status from every node')
  let st = await statuses(nodes)
  st.forEach((s, i) => console.log(`  ${NODES[i]} node=${s.node?.slice(0, 12)} cursor=${s.cursor} stateHash=${s.stateHash?.slice(0, 12)} nodeFile=${s.nodeFile ? 'yes' : 'no'} tmpFile=${s.tmpFile ? 'yes' : 'no'} feed=${s.feed}`))
  ok(new Set(st.map((s) => s.stateHash)).size === 1, 'all nodes report the same state hash')
  ok(new Set(st.map((s) => s.node)).size === nodes.length, 'each node has its own public key')
  ok(st.every((s) => s.nodeFile && s.tmpFile), 'node-local files exist (../bridge-node.json and /tmp/bridge-node.json)')
  ok(new Set(st.map((s) => s.nodeFile?.nonce)).size === nodes.length, 'non-consensus ../ file differs per node while ledgers still close')
  const cursor0: number = st[0].cursor

  console.log('\n2. Reads')
  const tokens = await read(nodes[0], { type: 'tokens' })
  ok(tokens.tokens?.find((t: any) => t.sym === 'PETAL')?.status === 'listed', 'PETAL is listed')
  const ops = await read(nodes[1], { type: 'operators' })
  ok(ops.k === genesis.config.k && ops.n === genesis.config.n, `operators k=${ops.k} n=${ops.n}`)

  console.log('\n3. Transfer intent through consensus (node 2)')
  const intent = await input(nodes[1], { type: 'intent.transfer', dir: 'in', sym: 'PETAL', amount: '1000', from: ALICE, to: EVM })
  const transferId: string | undefined = intent?.output?.transfer?.id
  const memo: string | undefined = intent?.output?.memo
  console.log(`  ledger ${intent?.ledger}: id=${transferId} memo=${memo} payTo=${intent?.output?.payTo}`)
  const { feeTo, feeMemo, feeDrops } = intent?.output ?? {}
  ok(transferId && memo && intent.output.payTo === LOCK, 'intent created with a memo and the lock account')
  ok(feeTo === FUND && feeMemo === `blume:fee:${transferId}` && feeDrops === '1000000', 'the intent names the fee: the funding account, its memo, and the drops pinned at the quote')
  const seen = await read(nodes[2], { type: 'transfer', id: transferId })
  ok(seen.transfer?.step === 1, 'node 3 sees the intent at step 1')

  console.log('\n4. Pretend ledger: the fee and the lock; node 3 also sees a payment that never happened')
  const fee = payment(FUND, { currency: 'XRP', value: '1' }, feeMemo, cursor0 + 2)
  const lock = payment(LOCK, { currency: PETAL.currency, issuer: PETAL.issuer, value: '1000' }, memo!, cursor0 + 3)
  const honest = { ledger: cursor0 + W, events: [fee, lock] }
  // A fee for an intent nobody made would be recorded and sent back if the lie won the vote.
  const lying = { ...honest, events: [...honest.events, payment(FUND, { currency: 'XRP', value: '999' }, 'blume:fee:0123456789abcdef', cursor0 + 4, BOB)] }
  feed(CONTAINERS[0], honest)
  feed(CONTAINERS[1], honest)
  feed(CONTAINERS[2], lying)

  const applied = await pollUntil('lock applied', async () => {
    const t = await read(nodes[0], { type: 'transfer', id: transferId })
    return t.transfer?.step >= 3 ? t.transfer : null
  })
  ok(applied?.step === 3 && applied?.srcTx === lock.tx, `transfer ${transferId} at step ${applied?.step} with srcTx ${applied?.srcTx?.slice(0, 8)}`)
  ok(applied?.receive === 1000 && applied?.feeTx === fee.tx, `receive ${applied?.receive}: the whole amount, against fee ${applied?.feeTx?.slice(0, 8)}`)
  st = await statuses(nodes)
  ok(new Set(st.map((s) => s.stateHash)).size === 1, `all nodes agree: stateHash ${st[0].stateHash?.slice(0, 12)}`)
  ok(st.every((s) => s.cursor === cursor0 + W), `cursor advanced to ${cursor0 + W} everywhere`)
  ok(st.every((s) => s.counts?.unmatched === 0), "the lying node's extra payment was outvoted: nothing is unmatched anywhere")
  const lastLying = st[2].lastRound
  console.log(`  node 3 last round: heard=${lastLying?.heard} timedOut=${lastLying?.timedOut} counts=${JSON.stringify(lastLying?.counts)} winner=${lastLying?.winner}`)
  const seen3 = await Promise.all(nodes.map((n) => read(n, { type: 'transfer', id: transferId })))
  ok(seen3.every((r) => r.transfer?.step === 3 && r.transfer?.receive === 1000), 'the transfer reads the same from every node')

  console.log('\n5. Slow node: node 2 broadcasts 1500ms late for the next window')
  const second = await input(nodes[0], { type: 'intent.transfer', dir: 'in', sym: 'PETAL', amount: '50', from: BOB, to: EVM })
  const secondId: string | undefined = second?.output?.transfer?.id
  setDelay(CONTAINERS[1], 1500)
  await sleep(2500)
  const fee2 = payment(FUND, { currency: 'XRP', value: '1' }, second.output.feeMemo, cursor0 + W + 2, BOB)
  const lock2 = payment(LOCK, { currency: PETAL.currency, issuer: PETAL.issuer, value: '50' }, second.output.memo, cursor0 + W + 3, BOB)
  const bare = payment(LOCK, { currency: PETAL.currency, issuer: PETAL.issuer, value: '25' }, EVM, cursor0 + W + 4, BOB)
  const next = { ledger: cursor0 + 2 * W, events: [...honest.events, fee2, lock2, bare] }
  for (const c of CONTAINERS) feed(c, next)
  const slow = await pollUntil('second lock applied on node 2', async () => {
    const t = await read(nodes[1], { type: 'transfer', id: secondId })
    return t.transfer?.step >= 3 ? t.transfer : null
  })
  ok(slow?.step === 3 && slow?.srcTx === lock2.tx && slow?.to === EVM, `the second intent minted ${slow?.receive} → ${slow?.to}`)
  await sleep(4000)
  st = await statuses(nodes)
  st.forEach((s, i) => console.log(`  ${NODES[i]} cursor=${s.cursor} stateHash=${s.stateHash?.slice(0, 12)} lastRound heard=${s.lastRound?.heard} timedOut=${s.lastRound?.timedOut}`))
  ok(new Set(st.map((s) => s.stateHash)).size === 1, 'all nodes converged after the slow round')
  setDelay(CONTAINERS[1], null)

  console.log('\n5b. A lock with a bare 0x memo names no intent: it is recorded, never minted')
  const strays = await Promise.all(nodes.map((n) => read(n, { type: 'unmatched' })))
  ok(strays.every((r) => r.unmatched?.some((u: any) => u.tx === bare.tx && u.reason === 'no-intent')), 'every node recorded it as unmatched: no-intent')
  const bareTransfers = await read(nodes[1], { type: 'transfers', from: BOB })
  ok(!bareTransfers.transfers?.some((t: any) => t.srcTx === bare.tx), 'and no transfer was made for it')

  console.log('\n6. hpcore log lines about forks or resyncs since the test started')
  for (const c of CONTAINERS) {
    const lines = hpcoreLines(c, startedIso)
    console.log(`  ${c}: ${lines.length ? lines.join(' | ') : 'none'}`)
  }
  const petal = await read(nodes[0], { type: 'token', sym: 'PETAL' })
  console.log(`\nPETAL locked=${petal.token?.lockedUnits} dust=${petal.token?.dustUnits}`)
  console.log(`\n${failures ? `${failures} check(s) FAILED` : 'ALL CHECKS PASSED'}`)
  for (const n of nodes) await n.client.close()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error('ERROR', e)
  process.exit(2)
})
