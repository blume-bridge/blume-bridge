/**
 * The live proof of a one-signature bridge on XRPL Devnet: alice creates an
 * inbound intent that pays the bridge fee in XRP, signs ONE Batch carrying the
 * lock and the fee, and the cluster mints her the full amount because the fee
 * did not come out of the token.
 *
 *   BRIDGE_NODE=bridge-dev.blumefi.com:8443 npx tsx scripts/devnet-proof.ts [amountPETAL] [0xEvmAddress]
 *
 * Devnet faucet money, alice's seed from keys/devnet.json, never printed.
 */
import { Client, Wallet, xrpToDrops, convertStringToHex } from 'xrpl'
import { genesisPath, loadKeys, network, wallet } from './testnet-lib'
import fs from 'node:fs'

const NODE = process.env.BRIDGE_NODE ?? 'bridge-dev.blumefi.com:8443'
const AMOUNT = process.argv[2] ?? '25'
const TO = (process.argv[3] ?? '0x1220980bA151A20Ebd589A51c80330FDdecF719b').toLowerCase()
const TF_ALL_OR_NOTHING = 65536
const TF_INNER_BATCH_TXN = 1073741824
const SOURCE_TAG = 2608140001

async function ask(json: string, input = false): Promise<any> {
  const { execFileSync } = await import('node:child_process')
  const args = ['dist-client/query/index.js', NODE, json]
  if (input) args.push('--input')
  // The client logs before it prints, so take the JSON document, not the whole stream.
  const raw = execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const at = raw.indexOf('{')
  if (at < 0) throw new Error(`no JSON from the node: ${raw.slice(0, 200)}`)
  return JSON.parse(raw.slice(at))
}

async function main() {
  const keys = loadKeys()
  if (!keys) throw new Error('no keys for this network; run testnet-setup first')
  const alice = wallet(keys, 'alice')
  const genesis = JSON.parse(fs.readFileSync(genesisPath(), 'utf8'))
  const petal = genesis.tokens.PETAL
  console.log(`  node ${NODE}, alice ${alice.classicAddress}, ${AMOUNT} PETAL -> ${TO}`)

  // 1. The intent, asking to pay the fee in XRP.
  const out = await ask(JSON.stringify({ type: 'intent.transfer', dir: 'in', sym: 'PETAL', amount: AMOUNT, from: alice.classicAddress, to: TO, fee: 'xrp' }), true)
  // Outputs arrive parsed or as JSON text depending on the client build.
  const reply = (out.outputs ?? []).map((o: unknown) => (typeof o === 'string' ? JSON.parse(o) : o)).find((o: any) => o?.type === 'intent.transfer.result')
  if (!reply) throw new Error(`no intent result: ${JSON.stringify(out).slice(0, 300)}`)
  const { transfer, memo, payTo, feeTo, feeMemo, feeDrops } = reply
  if (!feeTo || !feeDrops) throw new Error(`the cluster did not offer the XRP fee: ${JSON.stringify(reply).slice(0, 300)}`)
  console.log(`  intent ${transfer.id}: lock ${AMOUNT} PETAL -> ${payTo} memo ${memo}`)
  console.log(`  fee ${Number(feeDrops) / 1e6} XRP -> ${feeTo} memo ${feeMemo}; receive ${transfer.receive} (the whole amount)`)

  // 2. One Batch: the lock and the fee, all or nothing. The app fills every sequence and the outer fee itself.
  const client = new Client(network().ws)
  await client.connect()
  try {
    const info = await client.request({ command: 'account_info', account: alice.classicAddress, ledger_index: 'validated' })
    const seq = Number(info.result.account_data.Sequence)
    const validated = Number((await client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index)
    const inner = (fields: Record<string, unknown>, sequence: number) => ({
      RawTransaction: { TransactionType: 'Payment', Account: alice.classicAddress, Flags: TF_INNER_BATCH_TXN, Fee: '0', SigningPubKey: '', Sequence: sequence, SourceTag: SOURCE_TAG, ...fields },
    })
    const batch = {
      TransactionType: 'Batch',
      Account: alice.classicAddress,
      Flags: TF_ALL_OR_NOTHING,
      Sequence: seq,
      Fee: '1000',
      LastLedgerSequence: validated + 200,
      RawTransactions: [
        inner({ Destination: payTo, Amount: { currency: petal.currency, issuer: petal.issuer, value: AMOUNT }, Memos: [{ Memo: { MemoData: convertStringToHex(memo) } }] }, seq + 1),
        inner({ Destination: feeTo, Amount: feeDrops, Memos: [{ Memo: { MemoData: convertStringToHex(feeMemo) } }] }, seq + 2),
      ],
    }
    const signed = alice.sign(batch as any)
    const res = await client.submitAndWait(signed.tx_blob)
    const result = (res.result.meta as any)?.TransactionResult
    console.log(`  batch ${res.result.hash}: ${result} in ledger ${(res.result as any).ledger_index}`)
    if (result !== 'tesSUCCESS') throw new Error(`the batch failed: ${result}`)
  } finally {
    await client.disconnect()
  }

  // 3. Watch the cluster take it: the fee attaches, the lock mints the full amount.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 6000))
    const t = (await ask(JSON.stringify({ type: 'transfer', id: transfer.id }))).transfer
    if (!t) continue
    console.log(`  step ${t.step} fee ${t.feeXrp ?? '-'} XRP receive ${t.receive} ${t.done ? `done tx ${t.dstTx}` : t.failed ? `failed ${t.failed}` : ''}`)
    if (t.done) {
      // Every fee is XRP and nothing is taken from the token (the token fee and its feeMode are gone): the whole amount is minted and the XRP fee is on the record.
      if (!t.feeXrp || String(t.receive) !== AMOUNT) throw new Error(`expected the whole ${AMOUNT} minted against an XRP fee, got ${t.receive} with fee ${t.feeXrp}`)
      console.log(`\n  PROVEN: one signature, ${AMOUNT} PETAL locked and ${Number(feeDrops) / 1e6} XRP paid, ${t.receive} PETAL minted at ${t.dstTx}`)
      return
    }
    if (t.failed) throw new Error(`transfer failed: ${t.failed}`)
  }
  throw new Error('the transfer did not finish in four minutes')
}

main().catch((e) => {
  console.error('ERROR', e?.data ?? e?.message ?? e)
  process.exit(1)
})
