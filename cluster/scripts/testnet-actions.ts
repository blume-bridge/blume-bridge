/**
 * Real user actions on the XRPL network XRPL_NETWORK names (devnet by default),
 * signed by alice (or bob, carol) from keys/<network>.json.
 *
 * Bridging in is two payments, and the fee is XRP: the cluster quotes an intent,
 * and the user pays the fee to the funding account (memo blume:fee:<id>) before or
 * with the lock (memo blume:<id>:<0x>). A lock with no fee mints nothing: it waits.
 * The intent is asked of the cluster through the built query client, so run
 * `npm run build:client` once and point BRIDGE_NODE at a node (default: the dev front door).
 *
 *   npx tsx scripts/testnet-actions.ts lock <amountPETAL> <0xTo> [alice|bob|carol]        # intent, then the fee, then the lock: mints the full amount
 *   npx tsx scripts/testnet-actions.ts lock-xrp <amountXRP> <0xTo> [alice|bob|carol]
 *   npx tsx scripts/testnet-actions.ts lock-nofee <amountPETAL> <0xTo> [alice|bob|carol]  # intent and lock only: nothing mints, the lock waits for its fee
 *   npx tsx scripts/testnet-actions.ts fee <intentId> [amountXRP] [alice|bob|carol]       # the fee for a lock that is waiting for it (default: the 1 XRP quoted)
 *   npx tsx scripts/testnet-actions.ts return <lockTx> [amountXRP] [alice|bob|carol]      # pay (default 0.25 XRP) to have a lock that never paid its fee sent back
 *   npx tsx scripts/testnet-actions.ts propose <SYM> [name]  # alice pays the listing fee for SYM issued by mooIssuer: listed at once, but only if mooIssuer is locked for good
 *   npx tsx scripts/testnet-actions.ts list <SYM> [name] [imageLink]    # mooIssuer lists its own SYM for the flat fee (sets DefaultRipple first if it is off); the logo is an https:// or ipfs:// link, carried as it is
 *   npx tsx scripts/testnet-actions.ts meta <SYM> <name> [imageLink]    # mooIssuer changes SYM's name and logo (a link, as above; none removes the logo)
 *   npx tsx scripts/testnet-actions.ts send <r-address> <amountPETAL>     # alice → any account (needs its PETAL trust line)
 *   npx tsx scripts/testnet-actions.ts send-xrp <r-address> <amountXRP> [alice|bob|carol]
 *   npx tsx scripts/testnet-actions.ts trust <alice|bob|carol>              # that user's PETAL trust line
 *   npx tsx scripts/testnet-actions.ts balances
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { dropsToXrp, xrpToDrops } from 'xrpl'
import { CURRENCIES, USERS, loadKeys, network, payIou, payXrp, submit, validatedLedger, wallet, withClient, xrplNetwork, type Keys, type Role } from './testnet-lib'

const NODE = process.env.BRIDGE_NODE ?? 'bridge-dev.blumefi.com:8443'

/** The ledger code for a ticker: a known one, a 3-character one as itself, anything else as 40 hex. */
function currencyOf(sym: string): string {
  const known = (CURRENCIES as Record<string, string>)[sym.toUpperCase()]
  if (known) return known
  if (/^[A-Za-z0-9]{3}$/.test(sym)) return sym
  return Buffer.from(sym.padEnd(20, '\0')).toString('hex').toUpperCase()
}

/** One request to the cluster through the built query client (npm run build:client). A read, or with `input` a consensus input. */
function ask(message: Record<string, unknown>, input = false): any {
  const args = ['dist-client/query/index.js', NODE, JSON.stringify(message)]
  if (input) args.push('--input')
  // The client logs before it prints, so take the JSON document, not the whole stream.
  const raw = execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], cwd: path.join(__dirname, '..') })
  const at = raw.indexOf('{')
  if (at < 0) throw new Error(`no JSON from the node: ${raw.slice(0, 200)}`)
  return JSON.parse(raw.slice(at))
}

interface IntentReply {
  transfer: { id: string }
  memo: string
  payTo: string
  feeTo: string
  feeMemo: string
  feeDrops: string
}

/** An inbound intent for `from`: the memo the lock has to carry, where to pay it, and the fee the cluster quoted and pinned. */
function intentFor(sym: string, amount: string, from: string, to: string): IntentReply {
  const out = ask({ type: 'intent.transfer', dir: 'in', sym, amount, from, to }, true)
  // Outputs arrive parsed or as JSON text depending on the client build.
  const reply = (out.outputs ?? []).map((o: unknown) => (typeof o === 'string' ? JSON.parse(o) : o)).find((o: any) => o?.type === 'intent.transfer.result' || o?.type === 'error')
  if (!reply || reply.type === 'error') throw new Error(`the cluster refused the intent: ${reply?.error ?? JSON.stringify(out).slice(0, 200)}`)
  if (!reply.feeTo || !reply.feeDrops || !reply.feeMemo) throw new Error(`the cluster did not name its fee: ${JSON.stringify(reply).slice(0, 300)}`)
  return reply as IntentReply
}

/** Who signs: alice unless the last argument names bob or carol. */
function userFrom(keys: Keys, name: string | undefined): Role {
  const who = (name as Role) || 'alice'
  if (!USERS.includes(who) || !keys[who]) throw new Error(`unknown user ${who}`)
  return who
}

async function main() {
  const net = xrplNetwork()
  const keys = loadKeys()
  if (!keys) throw new Error(`no keys for ${network().label}: run XRPL_NETWORK=${net} npx tsx scripts/testnet-setup.ts first`)
  const [cmd, a, b, ...rest] = process.argv.slice(2)
  await withClient(async (client) => {
    const alice = wallet(keys, 'alice')
    switch (cmd) {
      case 'lock':
      case 'lock-xrp':
      case 'lock-nofee': {
        // `a` is the amount, `b` the 0x address that gets the mint, and the next argument who pays.
        const who = userFrom(keys, rest[0])
        const payer = wallet(keys, who)
        const xrpLock = cmd === 'lock-xrp'
        const q = intentFor(xrpLock ? 'XRP' : 'PETAL', a, payer.classicAddress, b)
        console.log(`  intent ${q.transfer.id}: lock ${a} ${xrpLock ? 'XRP' : 'PETAL'} → ${q.payTo} memo ${q.memo}; fee ${dropsToXrp(q.feeDrops)} XRP → ${q.feeTo} memo ${q.feeMemo}`)
        // The fee first, so the lock finds it attached and mints in one step; lock-nofee skips it and the lock waits.
        if (cmd !== 'lock-nofee') await payXrp(client, payer, q.feeTo, String(dropsToXrp(q.feeDrops)), q.feeMemo, `${who} pays the ${dropsToXrp(q.feeDrops)} XRP fee for ${q.transfer.id}`)
        if (xrpLock) await payXrp(client, payer, q.payTo, a, q.memo, `${who} locks ${a} XRP`)
        else await payIou(client, payer, q.payTo, CURRENCIES.PETAL, keys.issuer.address, a, q.memo, `${who} locks ${a} PETAL`)
        if (cmd === 'lock-nofee') console.log(`  the lock is waiting for its fee: finish it with  fee ${q.transfer.id} [amountXRP] ${who}  or take it back with  return <the lock tx above> [amountXRP] ${who}`)
        console.log(`  watch it: node dist-client/query/index.js ${NODE} '{"type":"transfer","id":"${q.transfer.id}"}'`)
        break
      }
      case 'fee': {
        // `a` is the intent id; the memo is the one the cluster handed out with the quote.
        const who = userFrom(keys, rest[0])
        await payXrp(client, wallet(keys, who), keys.funding.address, b ?? '1', `blume:fee:${a}`, `${who} pays the fee for ${a}`)
        break
      }
      case 'return': {
        // `a` is the lock's transaction hash. It has to be paid by the lock's own sender, for at least the return fee.
        const who = userFrom(keys, rest[0])
        await payXrp(client, wallet(keys, who), keys.funding.address, b ?? '0.25', `return:${a.toUpperCase()}`, `${who} pays to take back the lock ${a.slice(0, 8)}`)
        break
      }
      case 'propose': {
        // The community lane: anyone pays the listing fee, but the cluster lists it only when the issuer is locked for good.
        const memo = `propose:${JSON.stringify({ c: currencyOf(a), i: keys.mooIssuer.address, n: b })}`
        await payXrp(client, alice, keys.funding.address, '50', memo, `alice lists ${a} (${memo})`)
        break
      }
      case 'list': {
        // The issuer lane: the issuer's own payment is its consent. Without DefaultRipple the token could never reach the lock account, and the cluster refuses it.
        const issuer = wallet(keys, 'mooIssuer')
        const flags = Number((await client.request({ command: 'account_info', account: issuer.classicAddress })).result.account_data.Flags)
        if (!(flags & 0x00800000)) await submit(client, issuer, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 8 }, 'mooIssuer DefaultRipple')
        const memo = `propose:${JSON.stringify({ c: currencyOf(a), i: issuer.classicAddress, n: b, img: rest[0] })}`
        await payXrp(client, issuer, keys.funding.address, '50', memo, `mooIssuer lists ${a} (${memo})`)
        break
      }
      case 'meta': {
        const memo = `meta:${JSON.stringify({ c: currencyOf(a), n: b, img: rest[0] })}`
        await payXrp(client, wallet(keys, 'mooIssuer'), keys.funding.address, '5', memo, `mooIssuer updates ${a} (${memo})`)
        break
      }
      case 'send':
        // A user-to-user payment, not one into the bridge: no source tag.
        await submit(client, alice, { TransactionType: 'Payment', Account: alice.classicAddress, Destination: a, Amount: { currency: CURRENCIES.PETAL, issuer: keys.issuer.address, value: b } }, `alice sends ${b} PETAL to ${a}`)
        break
      case 'send-xrp': {
        const who = userFrom(keys, rest[0])
        await submit(client, wallet(keys, who), { TransactionType: 'Payment', Account: keys[who].address, Destination: a, Amount: xrpToDrops(b) }, `${who} sends ${b} XRP to ${a}`)
        break
      }
      case 'trust': {
        const who = userFrom(keys, a || 'bob')
        await submit(client, wallet(keys, who), { TransactionType: 'TrustSet', Account: keys[who].address, LimitAmount: { currency: CURRENCIES.PETAL, issuer: keys.issuer.address, value: '1000000000' } }, `${who} trusts PETAL`)
        break
      }
      case 'balances': {
        for (const role of ['alice', 'bob', 'carol', 'lock', 'funding'] as const) {
          if (!keys[role]) continue
          const info = await client.request({ command: 'account_info', account: keys[role].address })
          const lines = await client.request({ command: 'account_lines', account: keys[role].address })
          console.log(`  ${role} ${keys[role].address}: ${Number(info.result.account_data.Balance) / 1e6} XRP, ${lines.result.lines.map((l: any) => `${l.balance} ${l.currency.slice(0, 10)}`).join(', ') || 'no lines'}`)
        }
        break
      }
      default:
        throw new Error(`unknown command ${cmd}`)
    }
    console.log(`  ${network().label} validated ledger now ${await validatedLedger(client)}`)
  })
}

main().catch((e) => {
  console.error('ERROR', e?.data ?? e?.message ?? e)
  process.exit(1)
})
