/**
 * EVM-side test actions on XRPL EVM testnet, signed by alice's EVM key from
 * keys/testnet-evm.json (funded with faucet XRP for gas). The EVM side stays
 * on XRPL EVM testnet whichever ledger XRPL_NETWORK names; only the genesis
 * (minter, token identities) follows it.
 *   npx tsx scripts/testnet-evm.ts tokens                      # tokens the minter knows, by symbol, from the cluster's genesis identities
 *   npx tsx scripts/testnet-evm.ts balance <SYM> [0xaddress]   # ERC-20 balance (default alice)
 *   npx tsx scripts/testnet-evm.ts burn <SYM> <amount> <rAddress|X-address>   # alice burns to release on the XRP Ledger, paying the minter's exit fee in XRP
 *   npx tsx scripts/testnet-evm.ts send <SYM> <0xaddress> <amount>  # alice sends ERC-20 to another account (for a tester's burn)
 */
import fs from 'node:fs'
import path from 'node:path'
import { isValidClassicAddress, isValidXAddress, xAddressToClassicAddress } from 'ripple-address-codec'
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseUnits, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { MINTER_ABI, TOKEN_ABI, tokenIdOf } from '../src/evm'
// network.ts, not testnet-lib.ts: the genesis path without pulling xrpl into a viem-only script.
import { genesisPathFor, pickNetwork } from './network'

const RPC = 'https://rpc.testnet.xrplevm.org'
const chain = defineChain({ id: 1449000, name: 'XRPL EVM Testnet', nativeCurrency: { name: 'XRP', symbol: 'XRP', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain, transport: http(RPC) })

/** Read on first use, not at import: a bad XRPL_NETWORK or a missing file belongs on the ERROR line, not in an import-time stack trace. */
let cached: { genesis: any; minter: Hex; keys: { alice: { privateKey: Hex; address: Hex } } } | undefined
function ctx() {
  if (!cached) {
    const genesis = JSON.parse(fs.readFileSync(genesisPathFor(pickNetwork()), 'utf8'))
    const keys = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'keys', 'testnet-evm.json'), 'utf8')) as { alice: { privateKey: Hex; address: Hex } }
    cached = { genesis, minter: genesis.config.evm.minter as Hex, keys }
  }
  return cached
}

const TESTNET_CHAIN_ID = 1449000

/** Testnet only: the RPC and the genesis must both be the XRPL EVM testnet, checked before anything is signed. */
async function assertTestnet(): Promise<void> {
  const reported = await pub.getChainId()
  const configured = Number(ctx().genesis.config.evm.chainId)
  if (reported !== TESTNET_CHAIN_ID || configured !== TESTNET_CHAIN_ID) throw new Error(`the RPC reports chain ${reported} and the genesis names chain ${configured}; this script is for the XRPL EVM testnet (${TESTNET_CHAIN_ID}) only`)
}

/**
 * A classic address, or an X-address (47 characters, X on the main network, T on a test network). The contract
 * only looks at an X-address's length and first character, and the cluster cannot pay one with a bad checksum,
 * so the checksum is checked here, before any gas is spent. Returns what the destination means, for the log.
 */
function describeDestination(dest = ''): string {
  if (isValidClassicAddress(dest)) return `classic address ${dest}`
  if (isValidXAddress(dest)) {
    const { classicAddress, tag, test } = xAddressToClassicAddress(dest)
    return `X-address (${test ? 'test' : 'main'} network) for ${classicAddress}${tag === false ? ', no tag' : `, tag ${tag}`}`
  }
  throw new Error(`${dest} is not an XRP Ledger address: expected a classic r... address or an X-address (47 characters, X... or T...)`)
}

async function tokenAddress(sym: string): Promise<Hex> {
  const { genesis, minter } = ctx()
  const t = genesis.tokens[sym.toUpperCase()]
  if (!t) throw new Error(`unknown token ${sym}`)
  const addr = (await pub.readContract({ address: minter, abi: MINTER_ABI, functionName: 'tokens', args: [tokenIdOf(t)] })) as Hex
  if (!addr || /^0x0+$/.test(addr)) throw new Error(`${sym} is not listed on the minter yet`)
  return addr
}

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2)
  switch (cmd) {
    case 'tokens': {
      for (const sym of Object.keys(ctx().genesis.tokens)) {
        const addr = await tokenAddress(sym).catch((e) => String(e.message))
        console.log(`  ${sym}: ${addr}`)
      }
      break
    }
    case 'balance': {
      const addr = await tokenAddress(a)
      const who = (b ?? ctx().keys.alice.address) as Hex
      const wei = (await pub.readContract({ address: addr, abi: TOKEN_ABI, functionName: 'balanceOf', args: [who] })) as bigint
      console.log(`  ${who} holds ${formatUnits(wei, 18)} ${a.toUpperCase()} (${addr})`)
      break
    }
    case 'send': {
      await assertTestnet()
      const addr = await tokenAddress(a)
      const account = privateKeyToAccount(ctx().keys.alice.privateKey)
      const wallet = createWalletClient({ account, chain, transport: http(RPC) })
      const gasPrice = await pub.getGasPrice()
      const erc20 = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const
      const hash = await wallet.writeContract({ address: addr, abi: erc20, functionName: 'transfer', args: [b as Hex, parseUnits(c, 18)], gas: 200000n, gasPrice, type: 'legacy' })
      console.log(`  send ${c} ${a.toUpperCase()} → ${b}: tx ${hash}`)
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
      console.log(`  status ${receipt.status} block ${receipt.blockNumber}`)
      break
    }
    case 'burn': {
      await assertTestnet()
      const destination = describeDestination(c)
      const addr = await tokenAddress(a)
      const account = privateKeyToAccount(ctx().keys.alice.privateKey)
      const wallet = createWalletClient({ account, chain, transport: http(RPC) })
      // The exit fee is whatever the minter says it is right now; the token takes exactly that as msg.value and passes it on to the minter.
      const fee = (await pub.readContract({ address: ctx().minter, abi: MINTER_ABI, functionName: 'burnFee' })) as bigint
      const balance = await pub.getBalance({ address: account.address })
      if (balance < fee) throw new Error(`${account.address} holds ${formatUnits(balance, 18)} XRP, less than the ${formatUnits(fee, 18)} XRP exit fee (plus gas)`)
      console.log(`  exit fee ${formatUnits(fee, 18)} XRP, read from the minter; destination ${destination}`)
      const gasPrice = await pub.getGasPrice()
      const hash = await wallet.writeContract({ address: addr, abi: TOKEN_ABI, functionName: 'burn', args: [parseUnits(b, 18), c], value: fee, gas: 400000n, gasPrice, type: 'legacy' })
      console.log(`  burn ${b} ${a.toUpperCase()} → ${c}: tx ${hash}`)
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
      console.log(`  status ${receipt.status} block ${receipt.blockNumber}`)
      break
    }
    default:
      throw new Error('usage: tokens | balance <SYM> [0x] | burn <SYM> <amount> <rAddress|X-address> | send <SYM> <0x> <amount>')
  }
}

main().catch((e) => {
  console.error('ERROR', e?.shortMessage ?? e?.message ?? e)
  process.exit(1)
})
