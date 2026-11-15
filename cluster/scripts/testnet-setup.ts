/**
 * One-time XRPL setup for the dev cluster's real feed, on the network XRPL_NETWORK
 * names (devnet by default, testnet still supported):
 *   issuer     issues PETAL (DefaultRipple + NoFreeze)  → a listed token
 *   mooIssuer  issues nothing yet, flags default        → a token to propose
 *   lock       the cluster's lock account (trust line to PETAL)
 *   funding    the cluster's funding account
 *   alice      a user holding PETAL and XRP
 * Writes keys/<network>.json (seeds, gitignored, never printed) and genesis/<network>.json.
 * The EVM side is XRPL EVM testnet whichever ledger is chosen. Faucet networks only:
 * mainnet genesis files come from scripts/mainnet-genesis.ts, which makes no accounts.
 *
 *   XRPL_NETWORK=devnet BRIDGE_MINTER=0x... npx tsx scripts/testnet-setup.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, http, isAddress } from 'viem'
import type { State } from '../src/types'
import { params } from './genesis-params'
import type { NetworkName } from './network'
import { CURRENCIES, genesisPath, keysPath, loadKeys, network, saveKeys, submit, validatedLedger, wallet, withClient, xrplNetwork, type Keys, type Role } from './testnet-lib'
import type { Client } from 'xrpl'

/**
 * ThresholdMinter on XRPL EVM testnet, redeployed 2026-09-09 (replay-safe rotation, burn(0) rejected) with the
 * dev cluster's three node addresses as signers (contracts/script/DeployBridge.s.sol). It belongs to the Testnet
 * cluster only. Every XRPL network shares the EVM side, and tokenIdOf({native:true}) is keccak('XRP:native')
 * whichever ledger is bridged, so two clusters pointed at one minter share the XRP listing and its daily cap —
 * XRP minted from a Testnet lock could be burned and redeemed against the Devnet lock account. The coordinator
 * deploys a separate minter per cluster and passes it in BRIDGE_MINTER.
 */
const TESTNET_MINTER = '0x5689a50f6F69FCf37aB628eFCDF5C4a32D487A6A'
const EVM_RPC = 'https://rpc.testnet.xrplevm.org'

const ROLES: Role[] = ['issuer', 'mooIssuer', 'lock', 'funding', 'alice', 'bob', 'carol']
const ASF_DEFAULT_RIPPLE = 8
const ASF_NO_FREEZE = 6

/** What a genesis file carries; the rest of State starts empty (src/state.ts genesisState). */
type Genesis = Pick<State, 'config' | 'tokens' | 'cursor'>

function minterFor(name: NetworkName): string {
  const env = process.env.BRIDGE_MINTER?.trim()
  if (env) {
    if (!isAddress(env)) throw new Error(`BRIDGE_MINTER=${env} is not a 0x address`)
    return env
  }
  if (name !== 'testnet')
    throw new Error(`BRIDGE_MINTER is unset: the ${name} cluster needs its own ThresholdMinter, or it shares the XRP token id (and daily cap) with the Testnet cluster. Deploy one with contracts/script/DeployBridge.s.sol and pass BRIDGE_MINTER=0x...`)
  return TESTNET_MINTER
}

/** False only for actNotFound: any other rippled error is a real failure and must not look like a missing account. */
async function accountExists(client: Client, address: string): Promise<boolean> {
  try {
    await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
    return true
  } catch (e: any) {
    if ((e?.data?.error ?? '') === 'actNotFound') return false
    throw e
  }
}

async function main() {
  const net = xrplNetwork()
  const info = network()
  if (!info.faucet) throw new Error(`XRPL_NETWORK=${net} has no faucet: this script funds accounts. Use scripts/mainnet-genesis.ts for ${info.label}.`)
  // Relative when the key file is under the cwd, absolute when it is not: a KEYS_PATH outside the tree
  // otherwise prints as a chain of ../ that says nothing about where the seeds landed.
  const rel = path.relative(process.cwd(), keysPath())
  const keysFile = rel.startsWith('..') ? keysPath() : rel
  const minter = minterFor(net)
  console.log(`  network: ${info.label} (${info.ws})`)
  await withClient(async (client) => {
    const keys = loadKeys() ?? ({} as Keys)
    let added = 0
    for (const role of ROLES) {
      const known = keys[role]
      // Devnet is reset without warning: the key file outlives the accounts it names. Re-fund the roles the
      // ledger has forgotten instead of dying on the first account_info and blocking every deploy until
      // someone deletes the file by hand.
      if (known && (await accountExists(client, known.address))) continue
      const { wallet: w, balance } = await client.fundWallet()
      keys[role] = { address: w.classicAddress, seed: w.seed! }
      if (known) console.log(`  faucet: ${role} re-funded after a ledger reset, ${known.address} is gone → ${w.classicAddress} (${balance} XRP)`)
      else console.log(`  faucet: ${role} ${w.classicAddress} (${balance} XRP)`)
      added++
    }
    if (added) {
      saveKeys(keys)
      console.log(`  seeds saved to ${keysFile} (${added} funded)`)
    } else console.log(`  ${keysFile} complete, reusing accounts`)

    const issuer = wallet(keys, 'issuer')
    const lock = wallet(keys, 'lock')
    const alice = wallet(keys, 'alice')
    const petal = { currency: CURRENCIES.PETAL, issuer: issuer.classicAddress }

    const lines = async (addr: string) => (await client.request({ command: 'account_lines', account: addr })).result.lines
    const flags = Number((await client.request({ command: 'account_info', account: issuer.classicAddress })).result.account_data.Flags)
    if (!(flags & 0x00800000)) await submit(client, issuer, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: ASF_DEFAULT_RIPPLE }, 'issuer DefaultRipple')
    if (!(flags & 0x00200000)) await submit(client, issuer, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: ASF_NO_FREEZE }, 'issuer NoFreeze')
    if (!(await lines(alice.classicAddress)).some((l: any) => l.account === petal.issuer && l.currency === petal.currency))
      await submit(client, alice, { TransactionType: 'TrustSet', Account: alice.classicAddress, LimitAmount: { ...petal, value: '1000000000' } }, 'alice trusts PETAL')
    if (!(await lines(lock.classicAddress)).some((l: any) => l.account === petal.issuer && l.currency === petal.currency))
      await submit(client, lock, { TransactionType: 'TrustSet', Account: lock.classicAddress, Flags: 0x00020000, LimitAmount: { ...petal, value: '1000000000000' } }, 'lock trusts PETAL (NoRipple)')
    const aliceLine = (await lines(alice.classicAddress)).find((l: any) => l.account === petal.issuer && l.currency === petal.currency)
    if (!aliceLine || Number(aliceLine.balance) < 100000)
      await submit(client, issuer, { TransactionType: 'Payment', Account: issuer.classicAddress, Destination: alice.classicAddress, Amount: { ...petal, value: '100000' } }, 'issuer → alice 100000 PETAL')

    const cursor = await validatedLedger(client)
    const evmBlock = Number(await createPublicClient({ transport: http(EVM_RPC) }).getBlockNumber())
    const genesis: Genesis = {
      config: {
        k: 2,
        n: 3,
        feed: 'xrpl',
        // test.burn signs real releases from the lock account for anyone who can reach a node; real burns work now, so it stays off outside the fake-feed dev genesis.
        testHooks: false,
        xrpl: {
          rpc: info.rpc,
          lockAccount: lock.classicAddress,
          fundingAccount: keys.funding.address,
          windowLedgers: 5,
          network: 'test',
          maxEventsPerView: 50,
          pollMs: 8000,
        },
        params: params('test'),
        intentTtlMs: 3600000,
        // Operator keys (scripts/admin.ts keygen), optional on the test ledgers: their listings open with a default cap.
        ...(process.env.ADMIN_KEYS ? { admins: process.env.ADMIN_KEYS.split(',').map((k) => k.trim()).filter(Boolean) } : {}),
        evm: {
          rpc: [EVM_RPC],
          chainId: 1449000,
          minter,
          windowBlocks: 10,
          confirmations: 2,
          maxEventsPerView: 50,
          pollMs: 8000,
          gasLimit: 1500000,
          relayTimeoutMs: 180000,
        },
      },
      tokens: {
        XRP: { sym: 'XRP', name: 'XRP', native: true, issuer: 'native', status: 'listed', lockedUnits: '0', dustUnits: '0' },
        PETAL: { sym: 'PETAL', name: 'Petal', issuer: petal.issuer, currency: petal.currency, status: 'listed', capUnits: '1000000', lockedUnits: '0', dustUnits: '0', listedAt: Date.now() },
      },
      cursor: { xrpl: { ledger: cursor, seen: [] }, evm: { block: evmBlock, seen: [] } },
    }
    fs.writeFileSync(genesisPath(), JSON.stringify(genesis, null, 2) + '\n')
    console.log(`\n  genesis/${net}.json written: lock=${lock.classicAddress} funding=${keys.funding.address} cursor=${cursor} evmBlock=${evmBlock} minter=${minter}`)
    console.log(`  issuer=${issuer.classicAddress} mooIssuer=${keys.mooIssuer.address} alice=${alice.classicAddress}`)
    console.log(`  explorer: ${info.explorer}/accounts/${lock.classicAddress}`)

    // A release is multisigned by the operators, so an account without a SignerList takes locks and mints
    // happily and then rejects every release with tefNOT_MULTI_SIGNING. Switching networks creates fresh
    // accounts, so the list has to be set again once the new cluster has published its keys.
    const missing: string[] = []
    for (const [role, address] of [['lock', lock.classicAddress], ['funding', keys.funding.address]] as const) {
      const objects = await client.request({ command: 'account_objects', account: address, type: 'signer_list', ledger_index: 'validated' })
      if (!objects.result.account_objects.length) missing.push(role)
    }
    if (missing.length) {
      console.log(`\n  WARNING: ${missing.join(' and ')} ${missing.length > 1 ? 'have' : 'has'} no SignerList on ${info.label}, so every release will fail with tefNOT_MULTI_SIGNING.`)
      console.log(`  Deploy the cluster, wait for its operator set, then: XRPL_NETWORK=${net} npx tsx scripts/testnet-signerlist.ts`)
    } else console.log(`  SignerList present on the lock and funding accounts`)
  })
}

main().catch((e) => {
  console.error('ERROR', e?.data ?? e?.message ?? e)
  process.exit(1)
})
