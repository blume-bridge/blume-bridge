/**
 * Reads an account through the cluster's own feed code (src/feed/xrpl.ts: the
 * JSON-RPC path the nodes use, not the scripts' WebSocket) over the last N
 * validated ledgers of XRPL_NETWORK and prints every event it finds. A lock
 * from testnet-actions.ts should show up here as a payment; if it does not,
 * the nodes will not see it either.
 *
 *   XRPL_NETWORK=devnet npx tsx scripts/xrpl-feed-check.ts [ledgers=20] [account=genesis lock account]
 */
import fs from 'node:fs'
import { accountEvents, validatedLedger } from '../src/feed/xrpl'
import type { Amount, XrplConfig } from '../src/types'
import { genesisPath, network, xrplNetwork } from './testnet-lib'

const TIMEOUT_MS = 15000

/** Ledger currency codes are 40 hex chars for anything longer than three letters; show PETAL, not 5045…. */
function symbolOf(a: Amount): string {
  if (a.currency.length !== 40) return a.currency
  return Buffer.from(a.currency, 'hex').toString('utf8').replace(/\0+$/, '') || a.currency
}

async function main() {
  const [ledgersArg, accountArg] = process.argv.slice(2)
  const ledgers = Number(ledgersArg ?? 20)
  if (!Number.isInteger(ledgers) || ledgers < 1) throw new Error(`ledgers must be a positive integer, got ${ledgersArg}`)
  const net = xrplNetwork()
  const genesis = JSON.parse(fs.readFileSync(genesisPath(), 'utf8')) as { config: { xrpl: XrplConfig } }
  const cfg = genesis.config.xrpl
  const account = accountArg ?? cfg.lockAccount

  const to = await validatedLedger(cfg, TIMEOUT_MS)
  const from = Math.max(1, to - ledgers + 1)
  console.log(`  ${network().label} (genesis/${net}.json): ${account} ledgers ${from}..${to} via ${cfg.rpc.map((u) => new URL(u).host).join(', ')}`)
  const r = await accountEvents(cfg, account, from, to, TIMEOUT_MS)
  console.log(`  ${r.events.length} event(s), complete=${r.complete} lastLedger=${r.lastLedger} searchedMax=${r.searchedMax ?? 'unknown'}`)
  for (const e of r.events) {
    if (e.kind === 'payment') console.log(`  ledger ${e.ledger} payment ${e.tx}: ${e.amount.value} ${symbolOf(e.amount)} from ${e.from} memo=${e.memo ?? '(none)'}${e.batch ? ` batch=${e.batch}` : ''}`)
    else console.log(`  ledger ${e.ledger} outgoing ${e.tx}: ${e.type} seq=${e.sequence} ${e.result}${e.destination ? ` to ${e.destination}` : ''}${e.amount ? ` ${e.amount.value} ${symbolOf(e.amount)}` : ''}`)
  }
}

main().catch((e) => {
  console.error('ERROR', e?.message ?? e)
  process.exit(1)
})
