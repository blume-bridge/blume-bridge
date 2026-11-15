/**
 * Before a cluster boots from a snapshot that is older than the cluster was (a state backup restored after a lost box),
 * finds what it would do twice. The cluster remembers which burns it has paid in its state, and the ledger is the only
 * other place that knows: every release Payment names its burn in a memo (blume/burn). A snapshot taken hourly does not
 * know about the releases of the last hour, so a booted cluster reads those burns again and pays them again.
 *
 * This reads, from the public RPCs only:
 *   - the lock account's transactions since the snapshot's XRPL cursor: which burns already have a successful release;
 *   - every Burn event on the listed tokens since the snapshot's EVM cursor;
 * and writes the burns that were already released into the snapshot's EVM replay guard (cursor.evm.seen), so the
 * restored cluster skips them. Burns with no release stay as they are: the restored cluster will release them.
 *
 * It also reports, without touching anything, what it cannot fix by itself:
 *   - locks since the cursor that are already minted: the cluster will queue those mints again and the minter will refuse
 *     them (AlreadyMinted), leaving a failed transfer and a stuck action to clear; no money moves twice;
 *   - payments out of the funding account since the cursor: a payout may already have been paid, and the restored fees
 *     record does not know it. Compare fees.paidXrp.
 *
 *   npx tsx scripts/reconcile-snapshot.ts [genesis/snapshot.json]            # report only
 *   npx tsx scripts/reconcile-snapshot.ts [genesis/snapshot.json] --write    # also add the released burns to the snapshot
 *
 * Env: XRPL_RPC / EVM_RPC (comma separated; default the endpoints in the snapshot's config), RECONCILE_TIMEOUT_SECONDS (15).
 * --write keeps the original beside it as <file>.pre-reconcile. Read-only against the chains; it signs nothing.
 */
import fs from 'node:fs'
import { decodeFunctionResult, encodeFunctionData, getAbiItem, parseAbi, toEventSelector } from 'viem'
import { canon } from '../src/canon'
import { evmRpc, xrplRpc } from './rpc-util'

// ------------------------------------------------------------------ pure parts (tested)

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
const BURN_MEMO_TYPE = hex('blume/burn')
/** Topic 0 of the token's Burn event: keccak256("Burn(address,uint256,string,uint256)"). The event is the same in every minter version. */
const BURN_EVENT = parseAbi(['event Burn(address indexed from, uint256 amount, string rAddress, uint256 indexed nonce)'])
export const BURN_TOPIC = toEventSelector(getAbiItem({ abi: BURN_EVENT, name: 'Burn' }))
const MINTED_ABI = parseAbi(['function minted(bytes32 srcTx) view returns (bool)'])

interface RawEntry {
  hash?: string
  validated?: boolean
  ledger_index?: number
  tx?: any
  tx_json?: any
  meta?: any
}
const txOf = (e: RawEntry) => e.tx_json ?? e.tx
const hashOf = (e: RawEntry): string => String(e.hash ?? txOf(e)?.hash ?? '').toUpperCase()

function memoData(tx: any, type: string): string | null {
  for (const m of tx?.Memos ?? []) {
    const memo = m?.Memo
    if (memo && String(memo.MemoType ?? '').toUpperCase() === type && typeof memo.MemoData === 'string') return Buffer.from(memo.MemoData, 'hex').toString('utf8')
  }
  return null
}

/** burn tx hash (lower case) -> the release transaction (upper case) that paid it, from account_tx entries of the lock account. Only a successful, validated payment counts. */
export function releasedBurns(entries: RawEntry[], lockAccount: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of entries) {
    const tx = txOf(e)
    if (!tx || e.validated === false || tx.TransactionType !== 'Payment' || tx.Account !== lockAccount) continue
    if (e.meta?.TransactionResult !== 'tesSUCCESS') continue
    const burn = memoData(tx, BURN_MEMO_TYPE)
    if (burn) out.set(burn.toLowerCase(), hashOf(e))
  }
  return out
}

/** Successful payments into an account, newest data last as returned: hash (upper case) and ledger. */
export function paymentsInto(entries: RawEntry[], account: string): { tx: string; ledger: number }[] {
  const out: { tx: string; ledger: number }[] = []
  for (const e of entries) {
    const tx = txOf(e)
    if (!tx || e.validated === false || tx.TransactionType !== 'Payment' || tx.Destination !== account || e.meta?.TransactionResult !== 'tesSUCCESS') continue
    out.push({ tx: hashOf(e), ledger: Number(e.ledger_index ?? tx.ledger_index) })
  }
  return out
}

/** Transactions an account sent that the ledger accepted. */
export function sentBy(entries: RawEntry[], account: string): { tx: string; type: string; ledger: number }[] {
  const out: { tx: string; type: string; ledger: number }[] = []
  for (const e of entries) {
    const tx = txOf(e)
    if (!tx || e.validated === false || tx.Account !== account || e.meta?.TransactionResult !== 'tesSUCCESS') continue
    out.push({ tx: hashOf(e), type: String(tx.TransactionType), ledger: Number(e.ledger_index ?? tx.ledger_index) })
  }
  return out
}

export interface Burn {
  tx: string
  logIndex: number
  token: string
}
export interface Evidence {
  released: Map<string, string>
  burns: Burn[]
}

/** The replay-guard keys to add (`<tx>:<logIndex>`, as the cluster writes them) and the burns left for the cluster to release. */
export function reconcile(seen: string[], ev: Evidence): { add: string[]; alreadyGuarded: string[]; unreleased: Burn[]; releasedBurns: (Burn & { release: string })[] } {
  const have = new Set(seen)
  const add: string[] = []
  const alreadyGuarded: string[] = []
  const unreleased: Burn[] = []
  const done: (Burn & { release: string })[] = []
  for (const b of ev.burns) {
    const key = `${b.tx.toLowerCase()}:${b.logIndex}`
    const release = ev.released.get(b.tx.toLowerCase())
    if (!release) {
      unreleased.push(b)
      continue
    }
    done.push({ ...b, release })
    if (have.has(key)) alreadyGuarded.push(key)
    else if (!add.includes(key)) add.push(key)
  }
  return { add, alreadyGuarded, unreleased, releasedBurns: done }
}

// ------------------------------------------------------------------ reading the chains

interface Snapshot {
  config: { xrpl: { rpc: string[]; lockAccount: string; fundingAccount: string }; evm?: { rpc: string[]; minter: string } }
  tokens: Record<string, { sym: string; evmAddress?: string; native?: boolean }>
  cursor: { xrpl: { ledger: number; seen: string[] }; evm?: { block: number; seen: string[] } }
  fees?: { xrp?: string; paidXrp?: string; lastPayoutAt?: number }
}

async function accountTx(urls: string[], account: string, fromLedger: number, timeoutMs: number): Promise<RawEntry[]> {
  const out: RawEntry[] = []
  let marker: unknown
  for (let page = 0; page < 200; page++) {
    const r = await xrplRpc(urls, 'account_tx', { account, ledger_index_min: fromLedger, ledger_index_max: -1, forward: true, limit: 200, ...(marker ? { marker } : {}) }, timeoutMs)
    out.push(...((r.transactions ?? []) as RawEntry[]))
    marker = r.marker
    if (!marker) return out
  }
  throw new Error(`more than 200 pages of transactions on ${account} since ledger ${fromLedger}: the snapshot is too old to reconcile by this script`)
}

async function burnsSince(urls: string[], tokens: { sym: string; evmAddress: string }[], fromBlock: number, timeoutMs: number): Promise<{ burns: Burn[]; head: number }> {
  const head = Number(BigInt(await evmRpc(urls, 'eth_blockNumber', [], timeoutMs)))
  const burns: Burn[] = []
  const STEP = 2000
  for (const t of tokens) {
    for (let from = fromBlock + 1; from <= head; from += STEP) {
      const to = Math.min(head, from + STEP - 1)
      const logs = (await evmRpc(urls, 'eth_getLogs', [{ address: t.evmAddress, topics: [BURN_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }], timeoutMs)) as { transactionHash: string; logIndex: string }[]
      for (const l of logs) burns.push({ tx: l.transactionHash.toLowerCase(), logIndex: Number(l.logIndex), token: t.sym })
    }
  }
  return { burns, head }
}

async function alreadyMinted(urls: string[], minter: string, lockTxs: string[], timeoutMs: number): Promise<string[]> {
  const out: string[] = []
  for (const tx of lockTxs) {
    const data = encodeFunctionData({ abi: MINTED_ABI, functionName: 'minted', args: [`0x${tx.toLowerCase().padStart(64, '0')}`] })
    const res = await evmRpc(urls, 'eth_call', [{ to: minter, data }, 'latest'], timeoutMs)
    if (decodeFunctionResult({ abi: MINTED_ABI, functionName: 'minted', data: res })) out.push(tx)
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const file = args.find((a) => !a.startsWith('--')) ?? 'genesis/snapshot.json'
  const unknown = args.filter((a) => a.startsWith('--') && a !== '--write')
  if (unknown.length) throw new Error(`unknown argument ${unknown[0]}: expected --write`)
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot
  const timeoutMs = Number(process.env.RECONCILE_TIMEOUT_SECONDS ?? 15) * 1000
  const xrplUrls = (process.env.XRPL_RPC ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const xrpl = xrplUrls.length ? xrplUrls : snapshot.config.xrpl.rpc
  const lock = snapshot.config.xrpl.lockAccount
  const funding = snapshot.config.xrpl.fundingAccount
  const cursor = snapshot.cursor.xrpl.ledger
  console.log(`  snapshot ${file}: XRPL cursor ${cursor}${snapshot.cursor.evm ? `, EVM cursor ${snapshot.cursor.evm.block}` : ', no EVM side'}`)

  const lockEntries = await accountTx(xrpl, lock, cursor + 1, timeoutMs)
  const released = releasedBurns(lockEntries, lock)
  const locksIn = paymentsInto(lockEntries, lock)
  console.log(`  lock account ${lock}: ${locksIn.length} payment(s) in and ${released.size} release(s) out since ledger ${cursor}`)

  let toAdd: string[] = []
  if (snapshot.config.evm && snapshot.cursor.evm) {
    const evmUrls = (process.env.EVM_RPC ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const evm = evmUrls.length ? evmUrls : snapshot.config.evm.rpc
    const tokens = Object.values(snapshot.tokens).filter((t): t is { sym: string; evmAddress: string } => !!t.evmAddress)
    const { burns, head } = await burnsSince(evm, tokens, snapshot.cursor.evm.block, timeoutMs)
    const r = reconcile(snapshot.cursor.evm.seen, { released, burns })
    console.log(`  burns since EVM block ${snapshot.cursor.evm.block} (head ${head}): ${burns.length}`)
    for (const b of r.releasedBurns) console.log(`    ${b.token} burn ${b.tx.slice(0, 12)}.. already released by ${b.release.slice(0, 12)}..: ${r.alreadyGuarded.includes(`${b.tx}:${b.logIndex}`) ? 'already skipped by the snapshot' : 'will be skipped'}`)
    for (const b of r.unreleased) console.log(`    ${b.token} burn ${b.tx.slice(0, 12)}.. has no release on the ledger: the restored cluster will release it`)
    toAdd = r.add
    const minted = await alreadyMinted(evm, snapshot.config.evm.minter, locksIn.map((l) => l.tx), timeoutMs)
    if (minted.length) console.log(`  ${minted.length} lock(s) since the cursor are already minted: the restored cluster will queue those mints again and the minter will refuse them (AlreadyMinted): expect ${minted.length} failed transfer(s) and stuck EVM action(s) to clear. No money moves twice.`)
  } else console.log('  no EVM side in this snapshot: nothing to reconcile on the EVM side')

  const sent = sentBy(await accountTx(xrpl, funding, cursor + 1, timeoutMs), funding)
  if (sent.length) console.log(`  WARNING: the funding account ${funding} sent ${sent.length} transaction(s) since ledger ${cursor} (${[...new Set(sent.map((s) => s.type))].join(', ')}). If one was a payout, this snapshot does not know it was paid and the next payout could pay the same shares again: compare the snapshot's fees.paidXrp (${snapshot.fees?.paidXrp ?? '?'}) with what the funding account has paid, before the cluster starts.`)
  else console.log(`  the funding account sent nothing since ledger ${cursor}: no payout to worry about`)

  if (!toAdd.length) {
    console.log('  nothing to add to the snapshot.')
    return
  }
  if (!write) {
    console.log(`  ${toAdd.length} released burn(s) would be added to cursor.evm.seen. Run again with --write to do it.`)
    return
  }
  fs.copyFileSync(file, `${file}.pre-reconcile`)
  snapshot.cursor.evm!.seen.push(...toAdd)
  fs.writeFileSync(file, canon(snapshot) + '\n')
  console.log(`  ${toAdd.length} released burn(s) added to cursor.evm.seen in ${file} (the original is ${file}.pre-reconcile).`)
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR', (e as Error).message)
    process.exit(1)
  })
}
