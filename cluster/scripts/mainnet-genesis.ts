/**
 * Writes genesis/mainnet.json for the sole-operator mainnet cluster. Addresses
 * only, no seeds: the lock and funding accounts are created, funded and
 * SignerList-ed by the operator (scripts/testnet-signerlist.ts works for mainnet with
 * XRPL_NETWORK=mainnet and KEYS_PATH pointed at the mainnet key file), the minter is deployed by the operator
 * (contracts/script/DeployBridge.s.sol, --rpc-url xrpl_evm_mainnet).
 *
 *   K=3 N=5 LOCK=r... FUNDING=r... npx tsx scripts/mainnet-genesis.ts                 # first boot: XRPL only, so the nodes make and publish their keys; the EVM side is a plan in the genesis
 *                                                                                      # (config.evmPlan) and `scripts/admin.ts evm MINTER FROM` turns it on once the minter is deployed with those keys
 *   K=3 N=5 LOCK=r... FUNDING=r... MINTER=0x... npx tsx scripts/mainnet-genesis.ts    # a cluster that boots with its minter already known (the single-host path, where a second boot keeps the keys)
 *
 * Required: K and N, the signatures needed and the operators in the cluster. They are never assumed, because the
 * cluster starts as the operator's own nodes and widens; K must be a majority of N (two groups of K could otherwise sign
 * different things), and they have to match the SignerList quorum and the minter's threshold.
 *
 * Optional:
 *   TREASURY      the XRPL address that gets the treasury's 30% of the fees. Unset, the share stays in the funding account.
 *   XRPL_RPC      comma list of XRP Ledger servers (JSON-RPC) to read from, put in front of the public ones.
 *   EVM_RPC       the same for XRPL EVM. Operators run their own servers first and fall back to the public ones.
 *                 With neither, each node starts at a different public server so one liar is not believed by all of them; the
 *                 XRPL EVM side has one public server, so ACCEPT_SINGLE_EVM_RPC=1 is needed to boot on it alone (see rpcPolicy).
 *   DEFAULT_CAP_UNITS  the cap a new listing is put on the minter with. Unset, 0: a new listing takes nothing until an
 *                 operator sets a cap. (The seeds below keep the cap scripts/seed-build.ts priced for each.)
 *
 * The tokens are the seed list, seed/mainnet.json (scripts/seed-build.ts writes it the same day, with each token's cap
 * priced in XRP), listed with lane 'genesis' so the cluster opens the lock account's trust lines itself. SEED=none
 * boots with no tokens. XRP is not listed unless LIST_XRP=1: XRPL EVM already has native XRP through Axelar and
 * Wrapped XRP, and a third ERC-20 called XRP would only confuse people. XRP_CAP (default 200) caps it when it is.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isValidClassicAddress } from 'ripple-address-codec'
import { createPublicClient, fallback, http, isAddress } from 'viem'
import { configProblems } from '../src/state'
import type { Config, TokenRec } from '../src/types'
import { params as genesisParams, quorum, rpcPolicy, serversFirst, treasuryFrom } from './genesis-params'
import { NETWORKS, genesisPathFor } from './network'

const PUBLIC_EVM_RPC = ['https://rpc.xrplevm.org']
const CHAIN_ID = 1440000

/** One JSON-RPC call against these servers in order, the first answer wins. Read-only, like network.ts's jsonRpc, but over the operator's own list. */
async function xrplRpc<T = any>(urls: string[], method: string, params: Record<string, unknown>): Promise<T> {
  const errors: string[] = []
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [{ api_version: 2, ...params }] }) })
      const body = (await res.json()) as { result?: T & { status?: string; error?: string } }
      if (!body.result || body.result.status === 'error') throw new Error(body.result?.error ?? 'empty result')
      return body.result
    } catch (e) {
      errors.push(`${new URL(url).host}: ${(e as Error).message}`)
      // The account does not exist: every server will say so, and asking the next one only repeats it.
      if (/actNotFound|entryNotFound|objectNotFound/.test((e as Error).message)) break
    }
  }
  throw new Error(`${method} failed: ${errors.join('; ')}`)
}

/** The seed list scripts/seed-build.ts wrote, by key. */
function seedTokens(): Record<string, TokenRec> {
  const file = process.env.SEED ?? path.join(__dirname, '..', 'seed', 'mainnet.json')
  if (file === 'none') return {}
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist: run scripts/seed-build.ts first, or SEED=none to boot with no tokens`)
  const seed = JSON.parse(fs.readFileSync(file, 'utf8')) as { builtAt: string; tokens: Record<string, TokenRec> }
  const ageH = (Date.now() - Date.parse(seed.builtAt)) / 3_600_000
  // Prices, caps and each issuer's flags (clawback, freeze) move: a seed list from last week is a list of caps and checks nobody made today. Rebuilt the day of the boot, or the boot says so (ALLOW_OLD_SEED=1).
  if (ageH > 24) {
    const message = `${file} was built ${ageH.toFixed(0)} hours ago; prices, caps and issuer settings may have moved. Rebuild it the day of the boot (npx tsx scripts/seed-build.ts)`
    if (process.env.ALLOW_OLD_SEED !== '1') throw new Error(`${message}, or set ALLOW_OLD_SEED=1 to use it anyway.`)
    console.log(`  WARNING: ${message}. Using it anyway (ALLOW_OLD_SEED=1).`)
  }
  return seed.tokens
}

export interface GenesisInputs {
  k: number
  n: number
  lock: string
  funding: string
  /** The minter, when it already exists. Without one the EVM side is a plan. */
  minter?: string
  treasury?: string
  /** Where an operator that published no payout address is paid; the funding account holds it there. */
  operatorPayout?: string
  admins: string[]
  xrplRpcs: string[]
  evmRpcs: string[]
  rotateXrpl: boolean
  rotateEvm: boolean
  defaultCapUnits?: string
  /** The validated XRP Ledger ledger the nodes start reading after. */
  cursor: number
  /** The XRPL EVM block they start reading after, when the minter is known. */
  evmBlock: number
  seeded: Record<string, TokenRec>
  listXrp: boolean
  xrpCap: string
}

/** The genesis as a value: no network, no files, so it can be tested. */
export function buildGenesis(i: GenesisInputs) {
  const evmSide = { rpc: i.evmRpcs, chainId: CHAIN_ID, windowBlocks: 10, confirmations: 2, maxEventsPerView: 50, pollMs: 8000, gasLimit: 1500000, relayTimeoutMs: 180000, ...(i.rotateEvm ? {} : { rotate: false }) }
  return {
    config: {
      k: i.k,
      n: i.n,
      feed: 'xrpl',
      testHooks: false,
      xrpl: { rpc: i.xrplRpcs, lockAccount: i.lock, fundingAccount: i.funding, windowLedgers: 5, maxEventsPerView: 50, pollMs: 8000, network: 'mainnet', ...(i.rotateXrpl ? {} : { rotate: false }) },
      params: genesisParams('production', { defaultCapUnits: i.defaultCapUnits, treasuryAccount: i.treasury, operatorPayout: i.operatorPayout }),
      intentTtlMs: 3600000,
      admins: i.admins,
      // Without a minter the EVM side is a plan: everything but the minter, which `admin.ts evm` adds once it is deployed (it needs the nodes' keys, which do not exist before the first boot).
      ...(i.minter ? { evm: { ...evmSide, minter: i.minter } } : { evmPlan: evmSide }),
    },
    tokens: {
      ...i.seeded,
      // Only on request, and capped: capUnits is the lock cap and, at listing, the minter's daily cap.
      ...(i.listXrp ? { XRP: { sym: 'XRP', name: 'XRP', native: true, issuer: 'native', status: 'listed', capUnits: i.xrpCap, lockedUnits: '0', dustUnits: '0' } } : {}),
    },
    cursor: { xrpl: { ledger: i.cursor, seen: [] as string[] }, ...(i.minter ? { evm: { block: i.evmBlock, seen: [] as string[] } } : {}) },
  }
}

async function main() {
  // Everything that can be wrong with the inputs is found before the first network call.
  const { k, n } = quorum(process.env)
  const lock = process.env.LOCK ?? ''
  const funding = process.env.FUNDING ?? ''
  const minter = process.env.MINTER
  if (!isValidClassicAddress(lock) || !isValidClassicAddress(funding)) throw new Error('LOCK and FUNDING must be mainnet r-addresses')
  if (lock === funding) throw new Error('LOCK and FUNDING must differ')
  if (minter !== undefined && !isAddress(minter)) throw new Error('MINTER must be a 0x address')
  const treasury = treasuryFrom(process.env.TREASURY, lock)
  // The operators' 70% goes to each node's payout address, and on an Evernode instance nobody can write that file, so it would go to the node's own key, which the host reads. By default it is held in the funding account until a destination is set up.
  const operatorPayout = process.env.OPERATOR_PAYOUT?.trim() || funding
  if (!isValidClassicAddress(operatorPayout) || operatorPayout === lock) throw new Error('OPERATOR_PAYOUT must be an XRPL r-address other than the lock account (unset: the funding account, which holds the share)')
  if (treasury === funding) console.log('  NOTE: TREASURY is the funding account, so the treasury share stays where it is, as if TREASURY were unset.')
  const xrplRpcs = serversFirst('XRPL_RPC', process.env.XRPL_RPC, NETWORKS.mainnet.rpc)
  const evmRpcs = serversFirst('EVM_RPC', process.env.EVM_RPC, PUBLIC_EVM_RPC)
  const policy = rpcPolicy(process.env, xrplRpcs, evmRpcs)
  const defaultCapUnits = process.env.DEFAULT_CAP_UNITS?.trim() || undefined
  // The operator keys (scripts/admin.ts keygen). A new listing starts with no deposits until an operator sets its cap, so a mainnet cluster with nobody able to send that command could never open a token that is not on the seed list.
  const admins = (process.env.ADMIN_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)
  if (admins.length === 0) throw new Error('ADMIN_KEYS is required: the public key(s) printed by `npx tsx scripts/admin.ts keygen`, comma-separated. Without one, nobody can open a new listing, pause the bridge or fix a name.')

  const rpc = <T = any>(method: string, params: Record<string, unknown>) => xrplRpc<T>(xrplRpcs, method, params)
  for (const [name, addr] of [['lock', lock], ['funding', funding]] as const) {
    const info = await rpc<{ account_data: { Balance: string; Flags: number }; signer_lists?: unknown[] }>('account_info', { account: addr, ledger_index: 'validated', signer_lists: true })
    const xrp = Number(info.account_data.Balance) / 1e6
    const signers = (info.signer_lists ?? []).length
    console.log(`  ${name} ${addr}: ${xrp} XRP, ${signers ? 'SignerList set' : 'NO SignerList yet (set it once the nodes have published their keys)'}`)
  }
  const cursor = Number((await rpc<{ ledger_index: number }>('ledger', { ledger_index: 'validated' })).ledger_index)
  const evmBlock = Number(await createPublicClient({ transport: fallback(evmRpcs.map((url) => http(url))) }).getBlockNumber())
  const xrpCap = process.env.XRP_CAP ?? '200'
  const seeded = seedTokens()
  const listXrp = process.env.LIST_XRP === '1'
  const genesis = buildGenesis({ k, n, lock, funding, minter, treasury, operatorPayout, admins, xrplRpcs, evmRpcs, rotateXrpl: policy.rotateXrpl, rotateEvm: policy.rotateEvm, defaultCapUnits, cursor, evmBlock, seeded, listXrp, xrpCap })
  // The same check every node makes when it boots: a genesis a node would refuse is never written.
  const problems = configProblems(genesis.config as unknown as Config)
  if (problems.length) throw new Error(`the config would not run: ${problems.join('; ')}`)
  const out = genesisPathFor('mainnet')
  fs.writeFileSync(out, JSON.stringify(genesis, null, 2) + '\n')
  console.log(`\n  genesis/mainnet.json written: ${k} of ${n}, lock=${lock} funding=${funding} cursor=${cursor} ${minter ? `minter=${minter} evmBlock=${evmBlock}` : 'EVM side planned, minter to come (first boot): `admin.ts evm MINTER FROM` turns it on'} ${listXrp ? `XRP cap ${xrpCap}` : 'XRP not listed'}`)
  console.log(`  ${admins.length} operator key(s) may send operator commands: ${admins.map((a) => a.slice(0, 10) + '…').join(', ')}`)
  console.log(`  treasury: ${treasury && treasury !== funding ? treasury : 'none named: its 30% of the fees stays in the funding account'}`)
  console.log(`  operators' 70%: ${operatorPayout === funding ? "held in the funding account (nothing is paid out until a destination is set up)" : `to ${operatorPayout} for any operator that published no payout address`}`)
  console.log(`  new listings take a cap of ${genesis.config.params.defaultCapUnits} until an operator sets one`)
  console.log(`  XRP Ledger servers, in order: ${xrplRpcs.join(', ')}`)
  console.log(`  XRPL EVM servers, in order: ${evmRpcs.join(', ')}`)
  for (const note of policy.notes) console.log(`  NOTE: ${note}`)
  console.log(`  ${Object.keys(seeded).length} seeded tokens: ${Object.values(seeded).map((t) => t.ticker ?? t.sym).join(', ') || 'none'}`)
  console.log(`  explorer: ${NETWORKS.mainnet.explorer}/accounts/${lock}`)
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR', e?.message ?? e)
    process.exit(1)
  })
}
