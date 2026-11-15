import fs from 'node:fs'
import path from 'node:path'
import { BatchFlags, Client, GlobalFlags, convertStringToHex, xrpToDrops } from 'xrpl'
import type { Batch, Payment } from 'xrpl'
import { accountEvents, rpc } from '../src/feed/xrpl'
import type { XrplConfig, XrplOutgoingEvent, XrplPaymentEvent } from '../src/types'

/**
 * Proves the feed reads what a Batch (XLS-56) leaves on XRPL Devnet: one
 * signature from A pays B (a lock) and C (a fee) as two inner Payments, and
 * the feed must see both payments with the outer's hash, and A's side as one
 * outgoing Batch plus two outgoing inner Payments.
 *
 * Faucet accounts only; nothing is written unless `--fixture <path>` asks for
 * the raw account_tx responses, and seeds never leave memory.
 *
 *   npx tsx scripts/devnet-batch-check.ts [--fixture test/fixtures/devnet-batch-account-tx.json]
 */
const DEVNET_WS = 'wss://s.devnet.rippletest.net:51233'
const DEVNET_RPC = 'https://s.devnet.rippletest.net:51234/'
const TIMEOUT_MS = 5000
const LOCK_MEMO = 'blume:test:lock'
const FEE_MEMO = 'blume:fee:test'
const XRP_EACH = '1'

const failures: string[] = []
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function inner(from: string, to: string, memo: string): Payment {
  return {
    TransactionType: 'Payment',
    Account: from,
    Destination: to,
    Amount: xrpToDrops(XRP_EACH),
    Flags: GlobalFlags.tfInnerBatchTxn,
    Fee: '0',
    SigningPubKey: '',
    Memos: [{ Memo: { MemoData: convertStringToHex(memo) } }],
  }
}

/** The JSON-RPC server behind the pool may trail the one that validated the batch, so a read is retried until it has searched the ledger. */
async function eventsAt(cfg: XrplConfig, account: string, ledger: number) {
  let last = await accountEvents(cfg, account, ledger, ledger, TIMEOUT_MS)
  for (let attempt = 0; attempt < 15 && (last.searchedMax === null || last.searchedMax < ledger || last.events.length === 0); attempt++) {
    await sleep(2000)
    last = await accountEvents(cfg, account, ledger, ledger, TIMEOUT_MS)
  }
  return last
}

/**
 * The raw response the fixture is cut from, retried like eventsAt: a pooled
 * member that trails would answer with no transactions, and a fixture of
 * nothing would still let every check above pass.
 */
async function rawAccountTx(cfg: XrplConfig, account: string, ledger: number): Promise<{ transactions?: unknown[] }> {
  const read = () => rpc<{ transactions?: unknown[] }>(cfg.rpc, 'account_tx', { account, ledger_index_min: ledger, ledger_index_max: ledger, forward: true, limit: 200, binary: false }, TIMEOUT_MS)
  let last = await read()
  for (let attempt = 0; attempt < 15 && !last.transactions?.length; attempt++) {
    await sleep(2000)
    last = await read()
  }
  return last
}

async function main(): Promise<void> {
  const fixtureArg = process.argv.indexOf('--fixture')
  const fixturePath = fixtureArg >= 0 ? process.argv[fixtureArg + 1] : null
  if (fixtureArg >= 0 && !fixturePath) throw new Error('--fixture needs a path')

  const client = new Client(DEVNET_WS)
  await client.connect()
  try {
    const { wallet: A } = await client.fundWallet()
    const { wallet: B } = await client.fundWallet()
    const { wallet: C } = await client.fundWallet()
    console.log(`A (sender)  ${A.address}`)
    console.log(`B (lock)    ${B.address}`)
    console.log(`C (fee)     ${C.address}`)

    const batchTx: Batch = {
      TransactionType: 'Batch',
      Account: A.address,
      Flags: BatchFlags.tfAllOrNothing,
      RawTransactions: [{ RawTransaction: inner(A.address, B.address, LOCK_MEMO) }, { RawTransaction: inner(A.address, C.address, FEE_MEMO) }],
    }
    const prepared = await client.autofill(batchTx)
    const signed = A.sign(prepared)
    const submitted = await client.submitAndWait(signed.tx_blob)
    const outer = String(submitted.result.hash).toUpperCase()
    const ledger = Number(submitted.result.ledger_index)
    const outerMeta = submitted.result.meta
    const outerResult = typeof outerMeta === 'object' && outerMeta ? outerMeta.TransactionResult : String(outerMeta)
    console.log(`outer Batch ${outer} in ledger ${ledger} (${outerResult}), sequence ${prepared.Sequence}`)
    check(outerResult === 'tesSUCCESS', 'outer Batch validated tesSUCCESS')
    check(signed.hash.toUpperCase() === outer, 'validated hash matches the signed blob')

    const cfg: XrplConfig = { rpc: [DEVNET_RPC], lockAccount: B.address, fundingAccount: C.address, windowLedgers: 5, maxEventsPerView: 50, pollMs: 8000 }
    const expectAmount = { currency: 'XRP', value: XRP_EACH }

    for (const [name, to, memo] of [
      ['B', B.address, LOCK_MEMO],
      ['C', C.address, FEE_MEMO],
    ] as const) {
      const read = await eventsAt(cfg, to, ledger)
      const payments = read.events.filter((e): e is XrplPaymentEvent => e.kind === 'payment')
      check(read.complete && read.searchedMax !== null && read.searchedMax >= ledger, `${name}: server searched ledger ${ledger}`)
      check(read.events.length === 1 && payments.length === 1, `${name}: exactly one event, a payment (got ${read.events.map((e) => e.kind).join(',') || 'none'})`)
      const p = payments[0]
      if (p) {
        console.log(`inner Payment to ${name} ${p.tx}`)
        check(p.batch === outer, `${name}: payment carries the outer hash as batch`)
        check(p.from === A.address && p.to === to, `${name}: from A to ${name}`)
        check(p.amount.currency === expectAmount.currency && p.amount.value === expectAmount.value, `${name}: delivered ${XRP_EACH} XRP`)
        check(p.memo === memo, `${name}: memo ${memo}`)
        check(p.ledger === ledger, `${name}: in ledger ${ledger}`)
      }
    }

    const readA = await eventsAt(cfg, A.address, ledger)
    const outgoing = readA.events.filter((e): e is XrplOutgoingEvent => e.kind === 'outgoing')
    check(readA.complete && readA.searchedMax !== null && readA.searchedMax >= ledger, `A: server searched ledger ${ledger}`)
    check(readA.events.length === 3 && outgoing.length === 3, `A: three outgoing events (got ${readA.events.map((e) => `${e.kind}${'type' in e ? ':' + e.type : ''}`).join(',') || 'none'})`)
    const outers = outgoing.filter((e) => e.type === 'Batch')
    const inners = outgoing.filter((e) => e.type === 'Payment')
    check(outers.length === 1, 'A: one outgoing Batch')
    const o = outers[0]
    if (o) {
      check(o.tx === outer, 'A: the Batch event is the outer hash')
      check(o.inner === 2, `A: Batch carried inner: 2 (got ${o.inner})`)
      check(o.batch === undefined, 'A: the outer has no batch of its own')
      check(o.destination === undefined && o.amount === undefined, 'A: the outer has no destination or amount')
      check(o.result === 'tesSUCCESS' && o.sequence === Number(prepared.Sequence), `A: Batch tesSUCCESS at sequence ${prepared.Sequence}`)
    }
    check(inners.length === 2, 'A: two outgoing inner Payments')
    const bySeq = [...inners].sort((x, y) => x.sequence - y.sequence)
    const expectInner = [
      { destination: B.address, sequence: Number(prepared.Sequence) + 1 },
      { destination: C.address, sequence: Number(prepared.Sequence) + 2 },
    ]
    bySeq.forEach((e, i) => {
      const want = expectInner[i]
      check(e.batch === outer, `A: inner ${e.tx} carries the outer hash as batch`)
      check(e.inner === undefined, `A: inner ${e.tx} has no inner count`)
      check(e.destination === want?.destination && e.sequence === want?.sequence, `A: inner ${e.tx} to ${want?.destination} at sequence ${want?.sequence} (got ${e.destination} at ${e.sequence})`)
      check(e.amount?.currency === 'XRP' && e.amount?.value === XRP_EACH, `A: inner ${e.tx} asked ${XRP_EACH} XRP`)
      check(e.result === 'tesSUCCESS', `A: inner ${e.tx} tesSUCCESS`)
    })

    if (fixturePath) {
      const accountTx = {
        A: await rawAccountTx(cfg, A.address, ledger),
        B: await rawAccountTx(cfg, B.address, ledger),
        C: await rawAccountTx(cfg, C.address, ledger),
      }
      // The fixture is committed and the unit tests read every expectation out of it, so an empty capture must fail the run, not be written.
      const want = { A: 3, B: 1, C: 1 }
      const short = Object.entries(accountTx).filter(([who, res]) => (res.transactions?.length ?? 0) !== want[who as keyof typeof want])
      check(short.length === 0, `fixture: each account captured its transactions (short: ${short.map(([who, res]) => `${who}=${res.transactions?.length ?? 0}`).join(',') || 'none'})`)
      if (short.length === 0) {
        const fixture = { network: 'devnet', capturedAt: new Date().toISOString(), batch: outer, ledger, accounts: { A: A.address, B: B.address, C: C.address }, accountTx }
        fs.mkdirSync(path.dirname(fixturePath), { recursive: true })
        fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n')
        console.log(`fixture written to ${fixturePath}`)
      } else console.error('fixture NOT written: the capture is short')
    }
  } finally {
    await client.disconnect()
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
