import fs from 'node:fs'
import path from 'node:path'
import { Client, Wallet, convertStringToHex, xrpToDrops } from 'xrpl'
import { NETWORKS, genesisPathFor, keysPathFor, pickNetwork, type NetworkName, type XrplNetwork } from './network'

/**
 * Shared bits for the XRPL scripts. XRPL_NETWORK picks the ledger (devnet by
 * default: the Batch amendment is live there and off on testnet and mainnet)
 * and, with it, the endpoint, the key file and the genesis — see network.ts.
 * Seeds live in keys/<network>.json (gitignored) and are never printed; faucet
 * money only, except on mainnet, where the scripts read and the signing is
 * the operator's, by hand.
 *
 * These are functions, not module constants: an unknown XRPL_NETWORK has to
 * surface as a script's ERROR line, and a constant would throw at import time.
 */
export { NETWORKS, pickNetwork, type NetworkName, type XrplNetwork }

export function xrplNetwork(): NetworkName {
  return pickNetwork()
}

export function network(): XrplNetwork {
  return NETWORKS[xrplNetwork()]
}

export function keysPath(): string {
  return keysPathFor(xrplNetwork())
}

export function genesisPath(): string {
  return genesisPathFor(xrplNetwork())
}

export const BLUME_SOURCE_TAG = Number(process.env.BLUME_SOURCE_TAG ?? 2608140001)
export const CURRENCIES = {
  PETAL: '504554414C000000000000000000000000000000',
  MOO: '4D4F4F0000000000000000000000000000000000',
}

export type Role = 'issuer' | 'mooIssuer' | 'lock' | 'funding' | 'alice' | 'bob' | 'carol'
export type Keys = Record<Role, { address: string; seed: string }>
export const USERS: Role[] = ['alice', 'bob', 'carol']

export function loadKeys(): Keys | null {
  try {
    return JSON.parse(fs.readFileSync(keysPath(), 'utf8')) as Keys
  } catch {
    return null
  }
}

export function saveKeys(keys: Keys): void {
  const file = keysPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 })
}

export function wallet(keys: Keys, role: Role): Wallet {
  return Wallet.fromSeed(keys[role].seed)
}

export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(network().ws)
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.disconnect()
  }
}

export async function submit(client: Client, w: Wallet, tx: Record<string, unknown>, label: string): Promise<{ hash: string; ledger: number; result: string }> {
  const prepared = await client.autofill(tx as any)
  const signed = w.sign(prepared)
  const res = await client.submitAndWait(signed.tx_blob)
  const meta = res.result.meta as { TransactionResult?: string } | undefined
  const result = meta?.TransactionResult ?? 'unknown'
  const ledger = Number((res.result as any).ledger_index)
  console.log(`  ${label}: ${result} hash=${res.result.hash} ledger=${ledger}`)
  if (result !== 'tesSUCCESS') throw new Error(`${label} failed: ${result}`)
  return { hash: res.result.hash, ledger, result }
}

export function memoOf(text: string) {
  return { Memos: [{ Memo: { MemoData: convertStringToHex(text) } }] }
}

export async function payXrp(client: Client, from: Wallet, to: string, xrp: string, memo: string, label: string, tag = BLUME_SOURCE_TAG) {
  return submit(client, from, { TransactionType: 'Payment', Account: from.classicAddress, Destination: to, Amount: xrpToDrops(xrp), SourceTag: tag, ...memoOf(memo) }, label)
}

export async function payIou(client: Client, from: Wallet, to: string, currency: string, issuer: string, value: string, memo: string | null, label: string, tag = BLUME_SOURCE_TAG) {
  return submit(client, from, { TransactionType: 'Payment', Account: from.classicAddress, Destination: to, Amount: { currency, issuer, value }, SourceTag: tag, ...(memo ? memoOf(memo) : {}) }, label)
}

export async function validatedLedger(client: Client): Promise<number> {
  const r = await client.request({ command: 'ledger', ledger_index: 'validated' })
  return Number(r.result.ledger_index)
}
