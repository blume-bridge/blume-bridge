/**
 * The Evernode tenant wallet for the mainnet bridge cluster: the Xahau account that pays every instance's lease and
 * holds the right to extend or destroy them. It is a wallet of its own, separate from the throwaway one the rehearsals
 * used, because losing its seed means losing the instances (and, with them, the nodes' signing keys).
 *
 *   npx tsx scripts/evernode-tenant.ts new       # makes keys/evernode-tenant.txt (mode 600, never overwritten) and prints the ADDRESS only
 *   npx tsx scripts/evernode-tenant.ts status    # read-only: XAH, the EVR trust line, EVR, and what is still missing
 *   npx tsx scripts/evernode-tenant.ts trust --yes   # signs ONE TrustSet to the EVR issuer (a fee and a reserve; moves no EVR)
 *
 * Funding order is strict (docs/DESIGN.md): XAH first, then `trust`, then EVR,
 * because EVR cannot be sent to an account that has no trust line for it. The seed is read only to sign and is never
 * printed; `new` and `status` do not read it at all (status reads the `address=` line only). Back the seed up from your
 * own terminal (`cat keys/evernode-tenant.txt`), not through a chat or agent session.
 *
 * File format, the one scripts/evernode-cluster.sh already reads:  address=r...  seed=sEd...  created=<iso>
 * The seed is an `sEd...` (ed25519) seed, which every Xahau and Evernode library derives the same way.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Client, ECDSA, Wallet } from 'xrpl'

const EVR_ISSUER = 'rEvernodee8dJLaFsujS6q1EiXvZYmHXr8'
const ENDPOINT = process.env.XAHAU_WS ?? 'wss://xahau.network'
export const TENANT_FILE = process.env.TENANT_FILE ?? path.join(__dirname, '..', 'keys', 'evernode-tenant.txt')

/** What the tenant needs before three instances can be leased for `moments` moments each at `leasePerMoment` EVR, in XAH and EVR. */
export function fundingNeeded(opts: { instances: number; moments: number; leasePerMoment: number; baseReserve: number; ownerReserve: number }): { xah: number; evr: number } {
  // base reserve + the EVR trust line + one URIToken per leased instance, then room for the fees of acquires, extends and a rescue
  const reserves = opts.baseReserve + opts.ownerReserve * (1 + opts.instances)
  return { xah: Math.ceil(reserves + 5), evr: Math.ceil(opts.instances * opts.moments * opts.leasePerMoment * 1.25 * 100) / 100 }
}

function readAddress(): string {
  if (!fs.existsSync(TENANT_FILE)) throw new Error(`${TENANT_FILE} does not exist: run "new" first`)
  const line = fs.readFileSync(TENANT_FILE, 'utf8').split('\n').find((l) => l.startsWith('address='))
  const address = line?.slice('address='.length).trim()
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) throw new Error(`${TENANT_FILE} has no valid address= line`)
  return address
}

function readSeed(): string {
  const line = fs.readFileSync(TENANT_FILE, 'utf8').split('\n').find((l) => l.startsWith('seed='))
  const seed = line?.slice('seed='.length).trim()
  if (!seed) throw new Error(`${TENANT_FILE} has no seed= line`)
  return seed
}

function make(): void {
  fs.mkdirSync(path.dirname(TENANT_FILE), { recursive: true, mode: 0o700 })
  if (fs.existsSync(TENANT_FILE)) throw new Error(`${TENANT_FILE} already exists and is never overwritten. Its address: ${readAddress()}`)
  // ed25519 explicitly: a plain `s...` seed is derived differently by xrpl.js and by xrpl-accountlib (which evdevkit uses); an `sEd...` seed names its algorithm.
  const wallet = Wallet.generate(ECDSA.ed25519)
  fs.writeFileSync(TENANT_FILE, `address=${wallet.classicAddress}\nseed=${wallet.seed}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' })
  // Prove the file reproduces the address before anyone sends it money.
  const again = Wallet.fromSeed(readSeed())
  if (again.classicAddress !== wallet.classicAddress) {
    fs.rmSync(TENANT_FILE)
    throw new Error('the saved seed did not reproduce the address; nothing was kept')
  }
  console.log(`tenant wallet made: ${wallet.classicAddress}`)
  console.log(`  seed saved to ${TENANT_FILE} (mode 600, git-ignored). It was not printed. Back it up from your own terminal.`)
  console.log('  Fund it on Xahau MAINNET in this order: XAH, then run "trust", then EVR.')
}

interface Status {
  address: string
  exists: boolean
  xah: number
  baseReserve: number
  ownerReserve: number
  ownerCount: number
  trustLine: boolean
  evr: number
}

async function read(client: Client, address: string): Promise<Status> {
  const server = await client.request({ command: 'server_info' })
  const ledger = (server.result.info as { validated_ledger?: { reserve_base_xrp?: number; reserve_inc_xrp?: number } }).validated_ledger
  const baseReserve = ledger?.reserve_base_xrp ?? 1
  const ownerReserve = ledger?.reserve_inc_xrp ?? 0.2
  const info = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' }).catch((e: { data?: { error?: string } }) => (e?.data?.error === 'actNotFound' ? null : Promise.reject(e)))
  if (!info) return { address, exists: false, xah: 0, baseReserve, ownerReserve, ownerCount: 0, trustLine: false, evr: 0 }
  const lines = await client.request({ command: 'account_lines', account: address, peer: EVR_ISSUER })
  const line = (lines.result.lines as { currency: string; balance: string }[]).find((l) => l.currency === 'EVR')
  const data = info.result.account_data as { Balance: string; OwnerCount: number }
  return { address, exists: true, xah: Number(data.Balance) / 1e6, baseReserve, ownerReserve, ownerCount: data.OwnerCount, trustLine: !!line, evr: line ? Number(line.balance) : 0 }
}

async function status(): Promise<void> {
  const address = readAddress()
  const client = new Client(ENDPOINT)
  await client.connect()
  try {
    const s = await read(client, address)
    console.log(`tenant ${s.address} on Xahau mainnet`)
    if (!s.exists) {
      console.log(`  not funded yet: send XAH to it first (at least ${s.baseReserve + s.ownerReserve} to open it; ${fundingNeeded({ instances: 3, moments: 0, leasePerMoment: 0, baseReserve: s.baseReserve, ownerReserve: s.ownerReserve }).xah} to be comfortable)`)
      return
    }
    const reserve = s.baseReserve + s.ownerReserve * s.ownerCount
    console.log(`  XAH ${s.xah} (reserve held ${reserve.toFixed(2)}, spendable ${(s.xah - reserve).toFixed(2)})`)
    console.log(`  EVR trust line: ${s.trustLine ? 'set' : 'NOT SET: run "trust" before sending EVR'}   EVR ${s.evr}`)
    const need = fundingNeeded({ instances: 3, moments: 0, leasePerMoment: 0, baseReserve: s.baseReserve, ownerReserve: s.ownerReserve })
    console.log(`  XAH ${s.xah >= need.xah ? 'is enough' : `is short of the ${need.xah} comfortable for three instances`}`)
  } finally {
    await client.disconnect()
  }
}

async function trust(): Promise<void> {
  if (!process.argv.includes('--yes')) throw new Error('this signs one TrustSet (a network fee and a 0.2 XAH reserve; it moves no EVR). Add --yes')
  const address = readAddress()
  const wallet = Wallet.fromSeed(readSeed())
  if (wallet.classicAddress !== address) throw new Error('the seed in the file does not match its address= line; refusing to sign')
  const client = new Client(ENDPOINT)
  await client.connect()
  try {
    const s = await read(client, address)
    if (!s.exists) throw new Error(`${address} is not funded yet: send it XAH first`)
    if (s.trustLine) return console.log('the EVR trust line is already set; nothing to do')
    if (s.xah < s.baseReserve + s.ownerReserve * (s.ownerCount + 1) + 0.5) throw new Error(`${s.xah} XAH is too little to add a trust line (needs the reserve and a fee)`)
    const prepared = await client.autofill({ TransactionType: 'TrustSet', Account: address, LimitAmount: { currency: 'EVR', issuer: EVR_ISSUER, value: '1000000' } } as never)
    const signed = wallet.sign(prepared as never)
    const res = await client.submitAndWait(signed.tx_blob)
    const result = (res.result.meta as { TransactionResult?: string } | undefined)?.TransactionResult
    console.log(`TrustSet: ${result} hash=${res.result.hash}`)
    if (result !== 'tesSUCCESS') throw new Error(`the trust line was not set: ${result}`)
    console.log('EVR can be sent to the address now.')
  } finally {
    await client.disconnect()
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (cmd === 'new') return make()
  if (cmd === 'status') return status()
  if (cmd === 'trust') return trust()
  console.log('usage: npx tsx scripts/evernode-tenant.ts new | status | trust --yes')
  process.exit(1)
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR', e?.message ?? e)
    process.exit(1)
  })
}
