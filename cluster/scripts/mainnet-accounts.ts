/**
 * The two XRP Ledger mainnet accounts the cluster watches: the lock account (every bridged token sits there) and the
 * funding account (fees come in, payouts and refunds go out). Their master keys sign until the SignerList is on and the
 * master key is disabled (scripts/testnet-signerlist.ts), so until then the seeds are the money. They live in a file of
 * their own and are never printed.
 *
 *   npx tsx scripts/mainnet-accounts.ts new                 # makes keys/mainnet.json (mode 600, never overwritten) and prints the ADDRESSES only
 *   npx tsx scripts/mainnet-accounts.ts status [--tokens N]  # read-only: balance, reserve, what is missing, master key and SignerList (N: the day-one list, by default)
 *
 * Fund them from your own wallet (the money is yours to move). `status` says how much each needs: the account reserve, one
 * 0.2 XRP trust line per listed token on the lock account, the SignerList, and a float for fees and later listings. Back
 * the seeds up from your own terminal (`cat keys/mainnet.json`), not through a chat or agent session. KEYS_PATH moves the file,
 * as it does for testnet-signerlist.ts. `status` reads the addresses only; no command here signs anything.
 *
 * File format, the one testnet-signerlist.ts reads:  { "lock": { "address": "r...", "seed": "sEd..." }, "funding": { ... } }
 */
import fs from 'node:fs'
import path from 'node:path'
import { ECDSA, Wallet } from 'xrpl'
import { jsonRpc, keysPathFor } from './network'

const LSF_DISABLE_MASTER = 0x00100000
const ROLES = ['lock', 'funding'] as const
type Role = (typeof ROLES)[number]

/** The file this script owns: the mainnet key file, wherever KEYS_PATH puts it. */
export const keyFile = (): string => keysPathFor('mainnet')

/**
 * What each account should hold, in XRP, once `tokens` tokens are listed. The reserve is the base plus 0.2 for every object the
 * account owns: on the lock account one trust line per listed token and the SignerList, on the funding account the SignerList.
 * `comfortable` adds a float: room for ~50 later listings (one more trust line each) on the lock account, and for the fees of
 * multisigned payouts and refunds on the funding account. `floor` is the reserve and a few XRP of fees.
 */
export function accountNeeds(opts: { tokens: number; baseReserve: number; ownerReserve: number }): Record<Role, { reserve: number; floor: number; comfortable: number }> {
  const round = (n: number) => Math.round(n * 100) / 100
  const lockReserve = round(opts.baseReserve + opts.ownerReserve * (opts.tokens + 1))
  const fundingReserve = round(opts.baseReserve + opts.ownerReserve)
  return {
    lock: { reserve: lockReserve, floor: Math.ceil(lockReserve + 3), comfortable: Math.ceil(lockReserve + 10) },
    funding: { reserve: fundingReserve, floor: Math.ceil(fundingReserve + 3), comfortable: Math.ceil(fundingReserve + 8) },
  }
}

/** How many tokens the day-one list opens a trust line for: the picks marked launch (seed/picks.json). */
function launchTokens(): number {
  const picks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed', 'picks.json'), 'utf8')) as { launch?: boolean }[]
  return picks.filter((p) => p.launch).length
}

function addressesOf(): Record<Role, string> {
  const file = keyFile()
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist: run "new" first`)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { address?: string }>
  const out = {} as Record<Role, string>
  for (const role of ROLES) {
    const address = parsed[role]?.address
    if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) throw new Error(`${file} has no valid ${role} address`)
    out[role] = address
  }
  return out
}

function make(): void {
  const file = keyFile()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (fs.existsSync(file)) {
    const have = addressesOf()
    throw new Error(`${file} already exists and is never overwritten. lock ${have.lock}, funding ${have.funding}`)
  }
  // ed25519 explicitly, as for the tenant wallet: an `sEd...` seed names its algorithm, so every library derives the same account from it.
  const made = { lock: Wallet.generate(ECDSA.ed25519), funding: Wallet.generate(ECDSA.ed25519) }
  const body = { lock: { address: made.lock.classicAddress, seed: made.lock.seed }, funding: { address: made.funding.classicAddress, seed: made.funding.seed } }
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  // Prove the file reproduces both addresses before anyone sends it money.
  const again = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<Role, { address: string; seed: string }>
  for (const role of ROLES) {
    if (Wallet.fromSeed(again[role].seed).classicAddress !== again[role].address || again[role].address !== made[role].classicAddress) {
      fs.rmSync(file)
      throw new Error(`the saved ${role} seed did not reproduce its address; nothing was kept`)
    }
  }
  console.log('mainnet accounts made')
  console.log(`  lock     ${made.lock.classicAddress}`)
  console.log(`  funding  ${made.funding.classicAddress}`)
  console.log(`  seeds saved to ${file} (mode 600, git-ignored). They were not printed. Back them up from your own terminal.`)
  console.log('  Fund both on the XRP Ledger MAINNET; "status" says how much. Nothing else is needed before the first boot.')
}

interface View {
  address: string
  exists: boolean
  xrp: number
  ownerCount: number
  masterDisabled: boolean
  regularKey: string | null
  list: { quorum: number; entries: { address: string; weight: number }[] } | null
}

async function read(address: string): Promise<View> {
  const none: View = { address, exists: false, xrp: 0, ownerCount: 0, masterDisabled: false, regularKey: null, list: null }
  let info
  try {
    info = await jsonRpc<{ account_data: { Balance: string; OwnerCount: number; Flags: number; RegularKey?: string } }>('mainnet', 'account_info', { account: address, ledger_index: 'validated' })
  } catch (e) {
    if (/actNotFound/.test((e as Error).message)) return none
    throw e
  }
  const objects = await jsonRpc<{ account_objects: { SignerQuorum: number; SignerEntries: { SignerEntry: { Account: string; SignerWeight: number } }[] }[] }>('mainnet', 'account_objects', {
    account: address,
    type: 'signer_list',
    ledger_index: 'validated',
  })
  const found = objects.account_objects[0]
  const data = info.account_data
  return {
    address,
    exists: true,
    xrp: Number(data.Balance) / 1e6,
    ownerCount: data.OwnerCount,
    masterDisabled: (data.Flags & LSF_DISABLE_MASTER) !== 0,
    regularKey: data.RegularKey ?? null,
    list: found ? { quorum: found.SignerQuorum, entries: found.SignerEntries.map((e) => ({ address: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight })) } : null,
  }
}

async function status(): Promise<void> {
  const flag = process.argv.indexOf('--tokens')
  const tokens = flag >= 0 ? Number(process.argv[flag + 1]) : launchTokens()
  if (!Number.isInteger(tokens) || tokens < 0 || tokens > 100) throw new Error('--tokens is the number of tokens listed on day one (0 to 100)')
  const addresses = addressesOf()
  const server = await jsonRpc<{ info: { validated_ledger?: { reserve_base_xrp?: number; reserve_inc_xrp?: number } } }>('mainnet', 'server_info', {})
  const baseReserve = server.info.validated_ledger?.reserve_base_xrp ?? 1
  const ownerReserve = server.info.validated_ledger?.reserve_inc_xrp ?? 0.2
  const needs = accountNeeds({ tokens, baseReserve, ownerReserve })
  console.log(`XRP Ledger mainnet (reserve ${baseReserve} + ${ownerReserve} per object), sized for ${tokens} token(s):`)
  let ready = true
  for (const role of ROLES) {
    const v = await read(addresses[role])
    const need = needs[role]
    console.log(`\n${role.padEnd(7)} ${v.address}`)
    if (!v.exists) {
      ready = false
      console.log(`  not funded yet: send it XRP (at least ${need.floor}, ${need.comfortable} to be comfortable)`)
      continue
    }
    const held = baseReserve + ownerReserve * v.ownerCount
    console.log(`  ${v.xrp} XRP (reserve held ${held.toFixed(2)}, spendable ${(v.xrp - held).toFixed(2)}); ${v.ownerCount} object(s)`)
    if (v.xrp < need.floor) {
      ready = false
      console.log(`  SHORT: top it up to at least ${need.floor} XRP (${need.comfortable} to be comfortable)`)
    } else if (v.xrp < need.comfortable) console.log(`  enough to start; ${need.comfortable} XRP is comfortable`)
    else console.log('  funded')
    console.log(`  master key: ${v.masterDisabled ? 'DISABLED' : 'enabled'}   regular key: ${v.regularKey ?? 'none'}`)
    console.log(`  signers: ${v.list ? `${v.list.quorum} needed of ${v.list.entries.length}: ${v.list.entries.map((e) => `${e.address} (${e.weight})`).join(', ')}` : 'none yet'}`)
  }
  console.log(ready ? '\nboth accounts are funded enough for the first boot' : '\nnot ready: fund the accounts above, then run status again')
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (cmd === 'new') return make()
  if (cmd === 'status') return status()
  console.log('usage: npx tsx scripts/mainnet-accounts.ts new | status [--tokens N]')
  process.exit(1)
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR', e?.message ?? e)
    process.exit(1)
  })
}
