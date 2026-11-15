/**
 * Proves on XRPL Devnet (Batch amendment live) that an outer Batch built the
 * way the cluster builds one (batchTx + promotion), multisigned the way the
 * cluster signs (wallet.sign(tx, true) per operator, Signers combined by
 * assemble), goes through submit_multisigned and lands both inner payments.
 *
 *   npx tsx scripts/devnet-multisig-batch-check.ts
 *
 * Four faucet accounts are created for the run (a payer and three signers)
 * and thrown away; seeds never leave memory. Exits non-zero on any failure.
 */
import { Client, Wallet, decode, encode, hashes, xrpToDrops } from 'xrpl'
import { batchTx } from '../src/machine'
import { assemble } from '../src/signing'
import type { ActionRec, SignerEntry } from '../src/types'

const DEVNET_WS = process.env.XRPL_DEVNET_WS ?? 'wss://s.devnet.rippletest.net:51233/'
const TF_INDEPENDENT = 524288
const TF_INNER_BATCH_TXN = 1073741824
/** What the cluster stamps on every multisigned transaction (genesis params.xrplFeeDrops); covers (n+2) x base + the inners' zero fees. */
const OUTER_FEE = '1000'
const TTL_LEDGERS = 200

function fail(msg: string): never {
  console.error(`FAIL ${msg}`)
  process.exit(1)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The public Devnet node drops connection attempts under load often enough that one try is not a result. */
async function connect(client: Client): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect()
      return
    } catch (e) {
      if (attempt === 5) throw e
      console.log(`  connect attempt ${attempt}: ${(e as Error).message.split('.')[0]}; retrying`)
      await sleep(3000)
    }
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg)
}

async function validatedLedger(client: Client): Promise<number> {
  const r = await client.request({ command: 'ledger', ledger_index: 'validated' })
  return Number(r.result.ledger_index)
}

async function sequenceOf(client: Client, account: string): Promise<number> {
  const r = await client.request({ command: 'account_info', account, ledger_index: 'validated' })
  return Number(r.result.account_data.Sequence)
}

/** Polls `tx` until the hash is in a validated ledger, or gives up once the ledger passed its expiry. */
async function waitValidated(client: Client, hash: string, lastLedger: number): Promise<{ result: string; ledger: number; tx: any; meta: any }> {
  for (;;) {
    try {
      const r = await client.request({ command: 'tx', transaction: hash })
      const res = r.result as any
      if (res.validated) return { result: String(res.meta?.TransactionResult), ledger: Number(res.ledger_index), tx: res.tx_json ?? res, meta: res.meta }
    } catch (e) {
      if (!/txnNotFound/.test(String((e as any)?.data?.error ?? (e as Error).message))) throw e
    }
    if ((await validatedLedger(client)) > lastLedger) fail(`${hash} not validated by ledger ${lastLedger}`)
    await sleep(2000)
  }
}

function signerEntry(w: Wallet, tx: Record<string, unknown>): SignerEntry {
  const signed = w.sign({ ...(tx as any), SigningPubKey: '' }, true)
  const first = (decode(signed.tx_blob) as { Signers?: SignerEntry[] }).Signers?.[0]
  if (!first) throw new Error('no Signer in blob')
  return first
}

async function main() {
  const client = new Client(DEVNET_WS, { connectionTimeout: 20_000 })
  await connect(client)
  try {
    console.log(`devnet ${DEVNET_WS}`)
    // Faucet accounts, one at a time: the faucet rate-limits bursts.
    const wallets: Wallet[] = []
    for (const role of ['payer', 'signer1', 'signer2', 'signer3']) {
      const { wallet, balance } = await client.fundWallet()
      wallets.push(wallet)
      console.log(`  ${role}: ${wallet.classicAddress} (${balance} XRP)`)
    }
    const [payer, s1, s2, s3] = wallets

    // The payer's SignerList: quorum 2 of the three signers, weight 1 each, as testnet-signerlist.ts sets it on the cluster's accounts.
    const entries = [s1, s2, s3].map((w) => ({ SignerEntry: { Account: w.classicAddress, SignerWeight: 1 } })).sort((a, b) => (a.SignerEntry.Account < b.SignerEntry.Account ? -1 : 1))
    const sls = await client.submitAndWait(payer.sign(await client.autofill({ TransactionType: 'SignerListSet', Account: payer.classicAddress, SignerQuorum: 2, SignerEntries: entries })).tx_blob)
    const slsResult = (sls.result.meta as any)?.TransactionResult
    console.log(`  SignerListSet: ${slsResult} hash=${sls.result.hash}`)
    assert(slsResult === 'tesSUCCESS', `SignerListSet ${slsResult}`)

    // The outer exactly as the machine builds and promotes it: batchTx, then Account/Fee (queueAction), then Sequence S, inners S+1/S+2, expiry on the outer only (promoteActions).
    const S = await sequenceOf(client, payer.classicAddress)
    const validated = await validatedLedger(client)
    const lastLedger = validated + TTL_LEDGERS
    const built = batchTx(payer.classicAddress, [
      { TransactionType: 'Payment', Destination: s1.classicAddress, Amount: xrpToDrops('1') },
      { TransactionType: 'Payment', Destination: s2.classicAddress, Amount: xrpToDrops('1') },
    ], TF_INDEPENDENT) as any
    const tx: Record<string, unknown> = {
      ...built,
      Account: payer.classicAddress,
      Fee: OUTER_FEE,
      Sequence: S,
      LastLedgerSequence: lastLedger,
      RawTransactions: built.RawTransactions.map((r: any, i: number) => ({ RawTransaction: { ...r.RawTransaction, Sequence: S + 1 + i } })),
    }
    console.log(`  outer: seq ${S} inners ${S + 1},${S + 2} flags ${TF_INDEPENDENT} fee ${OUTER_FEE} until ${lastLedger}`)

    // Two operators sign on their own, the Signers are combined the way the cluster does it.
    const action: ActionRec = { id: 'devnet-check', kind: 'xrpl.batch', account: 'funding', tx, status: 'pending', reason: { kind: 'payout', at: 0 }, attempts: 0, createdAt: 0, updatedAt: 0, sequence: S, lastLedger, inner: [{ sequence: S + 1 }, { sequence: S + 2 }] }
    const signers = { [s1.classicAddress]: signerEntry(s1, tx), [s3.classicAddress]: signerEntry(s3, tx) }
    const assembled = assemble(action, { signers }, 2)
    assert(assembled, 'assemble returned null')
    console.log(`  signers: ${(assembled.Signers as SignerEntry[]).map((s) => s.Signer.Account).join(', ')}`)

    // The hash is ours to compute from the signed transaction; the response carries it too (top level on api_version 2, under tx_json on 1) and must agree.
    const localHash = hashes.hashSignedTx(encode(assembled as any)).toUpperCase()
    const sub = await client.request({ command: 'submit_multisigned', tx_json: assembled as any })
    const engine = (sub.result as any).engine_result as string
    const reported = String((sub.result as any).hash ?? (sub.result as any).tx_json?.hash ?? '').toUpperCase()
    console.log(`  submit_multisigned: ${engine} hash=${reported || '(not reported)'} local=${localHash}`)
    assert(!reported || reported === localHash, `reported hash ${reported} differs from the local ${localHash}`)
    const outerHash = localHash
    assert(engine === 'tesSUCCESS' || engine.startsWith('terQUEUED'), `submit_multisigned ${engine}: ${(sub.result as any).engine_result_message ?? ''}`)

    const outer = await waitValidated(client, outerHash, lastLedger)
    console.log(`  outer validated: ${outer.result} ledger=${outer.ledger}`)
    assert(outer.result === 'tesSUCCESS', `outer ${outer.result}`)
    assert(outer.tx.TransactionType === 'Batch' && Array.isArray(outer.tx.RawTransactions) && outer.tx.RawTransactions.length === 2, 'outer is not the 2-inner Batch we sent')

    // The inners are separate transactions in the outer's ledger, tied to it by meta.ParentBatchID.
    const at = await client.request({ command: 'account_tx', account: payer.classicAddress, ledger_index_min: outer.ledger, ledger_index_max: outer.ledger, limit: 50 })
    const inners = (at.result.transactions as any[])
      .map((e) => ({ hash: String(e.hash ?? e.tx_json?.hash ?? e.tx?.hash), tx: e.tx_json ?? e.tx, meta: e.meta }))
      .filter((e) => String(e.meta?.ParentBatchID ?? '').toUpperCase() === outerHash.toUpperCase())
      .sort((a, b) => Number(a.tx.Sequence) - Number(b.tx.Sequence))
    assert(inners.length === 2, `expected 2 inner transactions with ParentBatchID ${outerHash}, found ${inners.length}`)
    for (const [i, inner] of inners.entries()) {
      const fetched = await waitValidated(client, inner.hash, lastLedger)
      console.log(`  inner ${i + 1}: ${fetched.result} hash=${inner.hash} seq=${inner.tx.Sequence} fee=${inner.tx.Fee} flags=${inner.tx.Flags} to=${inner.tx.Destination} ledger=${fetched.ledger}`)
      assert(fetched.result === 'tesSUCCESS', `inner ${i + 1} ${fetched.result}`)
      assert(Number(inner.tx.Sequence) === S + 1 + i, `inner ${i + 1} sequence ${inner.tx.Sequence}, expected ${S + 1 + i}`)
      assert(String(inner.tx.Fee) === '0' && (Number(inner.tx.Flags) & TF_INNER_BATCH_TXN) !== 0 && !inner.tx.SigningPubKey, `inner ${i + 1} is not shaped as an inner`)
      assert(fetched.ledger === outer.ledger, `inner ${i + 1} landed in ledger ${fetched.ledger}, outer in ${outer.ledger}`)
    }
    const after = await sequenceOf(client, payer.classicAddress)
    assert(after === S + 3, `payer sequence ${after} after the batch, expected ${S + 3}`)

    console.log('OK')
    console.log(`  outer  ${outerHash}`)
    for (const [i, inner] of inners.entries()) console.log(`  inner${i + 1} ${inner.hash}`)
  } finally {
    await client.disconnect()
  }
}

main().catch((e) => {
  console.error('ERROR', e?.data ?? e)
  process.exit(1)
})
