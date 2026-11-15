/**
 * A live flood of the XRP Ledger feed, on a test network only: many one-drop payments, each with a fat memo, into the lock
 * account in the same ledger or two. Before the byte-bounded views (pre-mainnet review, root cause 3, 2026-10-17) about 45 of
 * them made every node's round message exceed HotPocket's 128 KiB limit and froze the feed for good. Now the cluster has to
 * work through them a piece at a time and carry on.
 *
 *   XRPL_NETWORK=devnet npx tsx scripts/devnet-flood.ts [count=90] [memoBytes=900]
 *
 * Signed by alice, bob and carol from keys/devnet.json (faucet money), a few thousand drops of fee each. It then watches the
 * cluster through BRIDGE_NODE (default the dev front door): the cursor must move past the flooded ledgers, every node must
 * end on one state hash, and the stray payments must show up in `unmatched` (they are recorded, never lost). Exit 1 if not.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { Client, convertStringToHex } from 'xrpl'
import { USERS, loadKeys, network, wallet, xrplNetwork } from './testnet-lib'

const NODE_HOST = process.env.BRIDGE_NODE_HOST ?? 'bridge-dev.blumefi.com'
const PORTS = (process.env.BRIDGE_NODE_PORTS ?? '8443,8444,8445').split(',')
const COUNT = Number(process.argv[2] ?? 90)
const MEMO_BYTES = Number(process.argv[3] ?? 900)

function ask(port: string, message: Record<string, unknown>): any {
  const raw = execFileSync('node', ['dist-client/query/index.js', `${NODE_HOST}:${port}`, JSON.stringify(message)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], cwd: path.join(__dirname, '..') })
  const at = raw.indexOf('{')
  if (at < 0) throw new Error(`no JSON from ${NODE_HOST}:${port}: ${raw.slice(0, 200)}`)
  return JSON.parse(raw.slice(at))
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const name = xrplNetwork()
  if (name === 'mainnet') throw new Error('this floods a ledger: test networks only')
  if (!Number.isInteger(COUNT) || COUNT < 1 || COUNT > 400) throw new Error('count must be 1 to 400')
  if (!Number.isInteger(MEMO_BYTES) || MEMO_BYTES < 1 || MEMO_BYTES > 900) throw new Error('memoBytes must be 1 to 900 (a memo, with its framing, may not pass 1 KB)')
  const keys = loadKeys()
  if (!keys) throw new Error('no keys for this network: run testnet-setup first')
  const lock = keys.lock.address
  const before = ask(PORTS[0], { type: 'status' })
  const unmatchedBefore: number = before.counts.unmatched
  console.log(`  ${name}: flooding the lock account ${lock} with ${COUNT} payments of a ${MEMO_BYTES}-byte memo; cluster cursor ${before.cursor}, ${unmatchedBefore} unmatched`)

  const client = new Client(network().ws)
  await client.connect()
  const blobs: string[] = []
  try {
    const validated = Number((await client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index)
    const senders = USERS.map((role) => wallet(keys, role))
    const per = Math.ceil(COUNT / senders.length)
    let made = 0
    for (const w of senders) {
      const info = await client.request({ command: 'account_info', account: w.classicAddress, ledger_index: 'current' })
      let sequence = Number(info.result.account_data.Sequence)
      for (let i = 0; i < per && made < COUNT; i++, made++) {
        const text = `flood ${w.classicAddress.slice(0, 6)} ${i} `.padEnd(MEMO_BYTES, 'x')
        const tx = {
          TransactionType: 'Payment' as const,
          Account: w.classicAddress,
          Destination: lock,
          Amount: '1',
          Fee: '2000',
          Sequence: sequence++,
          LastLedgerSequence: validated + 30,
          Memos: [{ Memo: { MemoData: convertStringToHex(text) } }],
        }
        blobs.push(w.sign(tx as never).tx_blob)
      }
    }
    // All at once, so they land in the same ledger or two.
    const results = await Promise.all(blobs.map((b) => client.request({ command: 'submit', tx_blob: b }).then((r) => (r.result as { engine_result?: string }).engine_result ?? '?')))
    const tally: Record<string, number> = {}
    for (const r of results) tally[r] = (tally[r] ?? 0) + 1
    console.log(`  submitted ${blobs.length}: ${JSON.stringify(tally)}`)
  } finally {
    await client.disconnect()
  }

  // Watch the cluster work through them.
  let last: any
  for (let i = 0; i < 40; i++) {
    await sleep(8000)
    last = ask(PORTS[0], { type: 'status' })
    const grown = last.counts.unmatched - unmatchedBefore
    console.log(`  cursor ${last.cursor} (${last.cursor - before.cursor} ledgers on), unmatched +${grown}`)
    if (grown >= COUNT - 5) break
  }
  const hashes = new Set<string>()
  const cursors: number[] = []
  for (const port of PORTS) {
    const s = ask(port, { type: 'status' })
    hashes.add(s.stateHash)
    cursors.push(s.cursor)
  }
  const log = ask(PORTS[0], { type: 'log', lines: 200 }).lines as string[]
  const partials = log.filter((l) => /carrying \d+ of them/.test(l))
  const oversize = log.filter((l) => /own message \d+ bytes/.test(l))
  console.log(`  node cursors ${cursors.join(', ')}; ${hashes.size} distinct state hash(es) (it can differ for a moment while a round is in flight)`)
  console.log(`  the log shows ${partials.length} partial-ledger window(s) and ${oversize.length} oversize-message line(s)`)
  for (const l of partials.slice(-3)) console.log(`    ${l.replace(/^\S+\s/, '').slice(0, 200)}`)
  const grown = last.counts.unmatched - unmatchedBefore
  const moved = last.cursor - before.cursor
  if (moved < 5) throw new Error(`the cursor moved only ${moved} ledgers: the feed is stuck`)
  if (grown < COUNT - 5) throw new Error(`only ${grown} of ${COUNT} flood payments were recorded (the unmatched list is capped at 500, so a flood past that drops the oldest)`)
  console.log(`\n  PROVEN: ${COUNT} fat payments were worked through, ${grown} recorded, the cursor moved ${moved} ledgers and the cluster carries on.`)
}

main().catch((e) => {
  console.error('ERROR', e?.data ?? e?.message ?? e)
  process.exit(1)
})
