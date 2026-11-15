/**
 * Checks that the keys in a decrypted backup are the keys they say they are: each node's XRPL seed derives the XRPL
 * address on record and its EVM private key derives the EVM address on record, and both match the backup's manifest.
 * A backup that decrypts but holds a truncated or wrong key is worse than none, so scripts/keys-restore.sh runs this
 * on every verify and every restore.
 *
 *   npx tsx scripts/keys-check.ts <dir>         # <dir>/manifest.json and <dir>/node<N>/contract_fs/seed/bridge-keys.json
 *
 * Prints addresses and ok/MISMATCH per node, never a seed or a private key, and exits 1 on any mismatch.
 */
import fs from 'node:fs'
import path from 'node:path'
import { privateKeyToAddress } from 'viem/accounts'
import { Wallet } from 'xrpl'

export interface NodeCheck {
  /** The address the key material derives, or null when it does not decode at all. */
  xrplAddress: string | null
  evmAddress: string | null
  errors: string[]
}

/** What one bridge-keys.json holds, derived and compared with what it claims. Nothing secret is returned or thrown. */
export function checkKeyFile(doc: unknown): NodeCheck {
  const errors: string[] = []
  const d = (typeof doc === 'object' && doc !== null ? doc : {}) as { xrpl?: { seed?: unknown; address?: unknown; publicKey?: unknown }; evm?: { privateKey?: unknown; address?: unknown } }
  let xrplAddress: string | null = null
  let evmAddress: string | null = null

  if (typeof d.xrpl?.seed !== 'string' || typeof d.xrpl?.address !== 'string') errors.push('the xrpl seed or address is missing')
  else {
    // xrpl.js derives ed25519 from a seed unless told otherwise, and a plain s... seed is secp256k1 everywhere else: try both.
    for (const algorithm of [undefined, 'ecdsa-secp256k1', 'ed25519'] as const) {
      try {
        const w = algorithm ? Wallet.fromSeed(d.xrpl.seed, { algorithm: algorithm as never }) : Wallet.fromSeed(d.xrpl.seed)
        xrplAddress ??= w.classicAddress
        if (w.classicAddress === d.xrpl.address && (typeof d.xrpl.publicKey !== 'string' || w.publicKey === d.xrpl.publicKey)) {
          xrplAddress = w.classicAddress
          break
        }
      } catch {
        /* this algorithm does not take this seed */
      }
    }
    if (xrplAddress === null) errors.push('the xrpl seed does not decode')
    else if (xrplAddress !== d.xrpl.address) errors.push(`the xrpl seed derives ${xrplAddress}, not the recorded ${d.xrpl.address}`)
  }

  if (typeof d.evm?.privateKey !== 'string' || typeof d.evm?.address !== 'string') errors.push('the evm private key or address is missing')
  else {
    try {
      evmAddress = privateKeyToAddress(d.evm.privateKey as `0x${string}`)
      if (evmAddress.toLowerCase() !== d.evm.address.toLowerCase()) errors.push(`the evm key derives ${evmAddress}, not the recorded ${d.evm.address}`)
    } catch {
      errors.push('the evm private key does not decode')
    }
  }
  return { xrplAddress, evmAddress, errors }
}

interface Manifest {
  format?: string
  nodes?: { n: number; xrplAddress?: string; evmAddress?: string; files?: string[] }[]
}

function main() {
  const dir = process.argv[2]
  if (!dir) throw new Error('usage: keys-check.ts <decrypted backup dir>')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
  if (manifest.format !== 'blume-bridge-keys/1') throw new Error(`unknown backup format ${JSON.stringify(manifest.format)}`)
  const nodes = manifest.nodes ?? []
  if (!nodes.length) throw new Error('the manifest lists no nodes')
  let bad = 0
  for (const m of nodes) {
    const file = path.join(dir, `node${m.n}`, 'contract_fs', 'seed', 'bridge-keys.json')
    let check: NodeCheck
    try {
      check = checkKeyFile(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch {
      check = { xrplAddress: null, evmAddress: null, errors: ['the key file is missing or is not JSON'] }
    }
    if (check.xrplAddress && check.xrplAddress !== m.xrplAddress) check.errors.push(`the manifest records ${m.xrplAddress} for the xrpl address`)
    if (check.evmAddress && check.evmAddress.toLowerCase() !== String(m.evmAddress).toLowerCase()) check.errors.push(`the manifest records ${m.evmAddress} for the evm address`)
    const payout = (m.files ?? []).includes('bridge-payout.json') && fs.existsSync(path.join(dir, `node${m.n}`, 'contract_fs', 'seed', 'bridge-payout.json'))
    if ((m.files ?? []).includes('bridge-payout.json') && !payout) check.errors.push('the manifest lists a payout file that is not in the backup')
    console.log(`  node ${m.n}  xrpl ${check.xrplAddress ?? '?'}  evm ${check.evmAddress ?? '?'}  payout file ${payout ? 'yes' : 'no'}  ${check.errors.length ? 'MISMATCH' : 'ok'}`)
    for (const e of check.errors) console.log(`    ${e}`)
    if (check.errors.length) bad++
  }
  if (bad) {
    console.error(`ERROR: ${bad} of ${nodes.length} node(s) do not check out`)
    process.exit(1)
  }
  console.log(`  ${nodes.length} node(s): every seed and private key derives the address on record`)
}

if (require.main === module) {
  try {
    main()
  } catch (e) {
    console.error('ERROR', (e as Error).message)
    process.exit(1)
  }
}
