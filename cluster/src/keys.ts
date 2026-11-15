import fs from 'node:fs'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { isValidClassicAddress } from 'ripple-address-codec'
import { Wallet } from 'xrpl'
import { log } from './log'
import type { OperatorKeys } from './types'

/**
 * This node's signing keys. Generated once, in the first consensus round, into
 * `../bridge-keys.json`: the parent of the state directory, which HotPocket
 * does not hash (KEYS.md). Only the public halves ever leave this file, and
 * they leave through the vote like everything else that differs per node.
 */
export const KEYS_PATH = '../bridge-keys.json'
/**
 * Where this node wants its payout share sent, if not its own bridge key.
 * Node-local and optional, next to the keys and equally unhashed: an operator
 * writes `{"address":"r..."}` to be paid at a cold wallet or an exchange
 * without ever moving its signing key.
 */
export const PAYOUT_PATH = '../bridge-payout.json'

export interface NodeKeys {
  xrpl: { seed: string; address: string; publicKey: string }
  evm: { privateKey: string; address: string }
  createdAt: number
}

export function loadKeys(): NodeKeys | null {
  try {
    return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')) as NodeKeys
  } catch {
    return null
  }
}

/**
 * This node's keys, made on the first round only. A key file that cannot be read is NOT a missing one: a node that
 * replaced its signing keys because of a transient read error (or an empty file from a half-finished write) would sign
 * with keys nobody has put on the SignerList or the minter, and with a log line as its only symptom. So new keys are
 * made only when the file is truly absent (ENOENT) and this node is not already an admitted operator (`mayGenerate`,
 * false once the operator set holds its HotPocket key); anything else throws and the round is lost on this node alone.
 * The write is atomic: a crash leaves the old file or the whole new one, never half of either.
 */
export function ensureKeys(opts: { path?: string; mayGenerate?: boolean } = {}): NodeKeys {
  const path = opts.path ?? KEYS_PATH
  let raw: string | null = null
  try {
    raw = fs.readFileSync(path, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw new Error(`keys: cannot read ${path} (${code ?? (e as Error).message}); not generating new ones, because a node that replaced its keys could no longer sign`)
  }
  if (raw !== null) {
    let parsed: NodeKeys
    try {
      parsed = JSON.parse(raw) as NodeKeys
    } catch {
      throw new Error(`keys: ${path} exists but is not valid JSON (${raw.length} bytes); refusing to replace it. Restore it from the key backup (scripts/keys-restore.sh)`)
    }
    if (!parsed?.xrpl?.seed || !parsed?.evm?.privateKey) throw new Error(`keys: ${path} exists but holds no keys; refusing to replace it. Restore it from the key backup (scripts/keys-restore.sh)`)
    return parsed
  }
  if (opts.mayGenerate === false) throw new Error(`keys: ${path} is missing, but this node is already an admitted operator, so new keys would never be on the SignerList or the minter. Restore it from the key backup (scripts/keys-restore.sh)`)
  const w = Wallet.generate()
  const priv = secp256k1.utils.randomPrivateKey()
  const pub = secp256k1.getPublicKey(priv, false).slice(1)
  const keys: NodeKeys = {
    xrpl: { seed: w.seed!, address: w.classicAddress, publicKey: w.publicKey },
    evm: { privateKey: '0x' + Buffer.from(priv).toString('hex'), address: '0x' + Buffer.from(keccak_256(pub).slice(-20)).toString('hex') },
    createdAt: Date.now(),
  }
  const tmp = `${path}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, JSON.stringify(keys))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, path)
  log(`keys: generated xrpl ${keys.xrpl.address} evm ${keys.evm.address}`)
  return keys
}

/** The payout address this node publishes, or null when it has not set one. A file with a bad address is ignored rather than obeyed: it would send the share nowhere. */
export function loadPayoutAddress(): string | null {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(PAYOUT_PATH, 'utf8'))
  } catch {
    return null
  }
  const address = String((raw as { address?: unknown })?.address ?? '')
  if (!isValidClassicAddress(address)) {
    log(`payout: ${PAYOUT_PATH} has no valid classic address; paying this node at its own key`)
    return null
  }
  return address
}

export function publicKeys(node: string, keys: NodeKeys): OperatorKeys {
  return { node, xrplAddress: keys.xrpl.address, xrplPublicKey: keys.xrpl.publicKey, evmAddress: keys.evm.address, payoutAddress: loadPayoutAddress() ?? keys.xrpl.address }
}

export function xrplWallet(keys: NodeKeys): Wallet {
  return Wallet.fromSeed(keys.xrpl.seed)
}
