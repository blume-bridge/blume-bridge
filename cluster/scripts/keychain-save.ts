/**
 * Copies the bridge's secrets from their key files into the macOS login Keychain, as a second place they live. The files stay
 * the working copies (the scripts read them); the Keychain is the one that survives a deleted folder. Nothing secret is printed.
 *
 *   npx tsx scripts/keychain-save.ts          # saves what is there (updating an item that already exists) and reads each back
 *   npx tsx scripts/keychain-save.ts check    # read-only: says whether each Keychain item still matches its file
 *
 * What goes in, as service / account:
 *   blume-bridge-mainnet-lock-seed       the lock account's address     keys/mainnet.json  (lock.seed)
 *   blume-bridge-mainnet-funding-seed    the funding account's address  keys/mainnet.json  (funding.seed)
 *   blume-bridge-evernode-tenant-seed    the tenant wallet's address    keys/evernode-tenant.txt  (seed=)
 *   blume-bridge-admin-mainnet-key       the operator key's public key  keys/admin-mainnet.json  (the seed half of privateKeyHex)
 *   blume-bridge-upgrade-mainnet-key     the upgrade key's public key   keys/upgrade-mainnet.json  (the seed half of privateKeyHex)
 *
 * The operator key is stored as its 32-byte seed (64 hex characters): the whole private key is 130 characters, more than a
 * terminal password prompt takes (about 127). HotPocket's private key is `ed` + seed + the public key without its `ed`, so
 * the seed and the public key are the whole key. The Keychain item's comment says how to put it back together.
 *
 * `security add-generic-password -w <secret>` would put the secret in the process list, so the secret goes the other way:
 * `security` asks for it at a terminal, script(1) supplies the terminal, and the secret travels on that terminal's input.
 * KEYCHAIN_PREFIX renames the services (the tests use it), TENANT_FILE, KEYS_PATH, ADMIN_KEY_FILE and UPGRADE_KEY_FILE move the files.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { keysPathFor } from './network'

const PKG = path.join(__dirname, '..')
const prefix = () => process.env.KEYCHAIN_PREFIX?.trim() || 'blume-bridge'

export interface Entry {
  service: string
  /** The public half: an address or public key, so the item says what it opens. */
  account: string
  secret: string
  /** Kept in the item's comment field: how to use what is stored. Not secret. */
  note?: string
}

/** More than this does not fit through a terminal password prompt (getpass takes 127 characters on macOS). */
const MAX_SECRET_CHARS = 120

const need = (value: string | undefined, what: string, file: string): string => {
  if (!value) throw new Error(`${file} has no ${what}`)
  return value
}

/** Every secret the files hold, named for the Keychain. A file that is missing is skipped, and the skip is reported. */
export function entries(): { found: Entry[]; missing: string[] } {
  const found: Entry[] = []
  const missing: string[] = []
  const p = prefix()

  const mainnet = keysPathFor('mainnet')
  if (fs.existsSync(mainnet)) {
    const keys = JSON.parse(fs.readFileSync(mainnet, 'utf8')) as Record<'lock' | 'funding', { address?: string; seed?: string }>
    for (const role of ['lock', 'funding'] as const) found.push({ service: `${p}-mainnet-${role}-seed`, account: need(keys[role]?.address, `${role} address`, mainnet), secret: need(keys[role]?.seed, `${role} seed`, mainnet) })
  } else missing.push(mainnet)

  const tenant = process.env.TENANT_FILE ?? path.join(PKG, 'keys', 'evernode-tenant.txt')
  if (fs.existsSync(tenant)) {
    const lines = fs.readFileSync(tenant, 'utf8').split('\n')
    const field = (name: string) => lines.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).trim()
    found.push({ service: `${p}-evernode-tenant-seed`, account: need(field('address'), 'address= line', tenant), secret: need(field('seed'), 'seed= line', tenant) })
  } else missing.push(tenant)

  // HotPocket user keys: 'ed' + seed (64 hex) + public key (64 hex) in the file, stored as the seed half.
  for (const [name, env, file] of [['admin', 'ADMIN_KEY_FILE', 'admin-mainnet.json'], ['upgrade', 'UPGRADE_KEY_FILE', 'upgrade-mainnet.json']] as const) {
    const where = process.env[env] ?? path.join(PKG, 'keys', file)
    if (!fs.existsSync(where)) {
      missing.push(where)
      continue
    }
    const key = JSON.parse(fs.readFileSync(where, 'utf8')) as { privateKeyHex?: string; publicKeyHex?: string }
    const priv = need(key.privateKeyHex, 'privateKeyHex', where)
    const pub = need(key.publicKeyHex, 'publicKeyHex', where)
    if (!/^ed[0-9a-f]{128}$/.test(priv) || !/^ed[0-9a-f]{64}$/.test(pub) || priv.slice(66) !== pub.slice(2)) throw new Error(`${where} is not an ed + seed + public key pair`)
    found.push({ service: `${p}-${name}-mainnet-key`, account: pub, secret: priv.slice(2, 66), note: 'seed half of the HotPocket private key. Whole key = "ed" + this seed + the account (public key) without its "ed"' })
  }

  return { found, missing }
}

/** Adds or updates one item. The secret is typed at security's own prompt (twice, as it asks), never given as an argument. */
export function saveSecret(service: string, account: string, secret: string, note?: string): Promise<void> {
  if (secret.length > MAX_SECRET_CHARS) return Promise.reject(new Error(`the secret for ${service} is ${secret.length} characters; a terminal prompt takes ${MAX_SECRET_CHARS}`))
  return new Promise((resolve, reject) => {
    // `< <(cat)` because script(1) refuses a socket for an input (Node's pipes are sockets on macOS) and takes a real pipe.
    const child = spawn('/bin/bash', ['-c', 'exec script -q /dev/null "$@" < <(cat)', 'bash', 'security', 'add-generic-password', '-U', '-a', account, '-s', service, ...(note ? ['-j', note] : []), '-w'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let heard = ''
    let complaint = ''
    let typed = 0
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`security did not ask for the password for ${service}`))
    }, 20_000)
    child.stdout.on('data', (chunk: Buffer) => {
      heard += chunk.toString()
      // What it said is discarded, never shown: if the terminal echoed the secret, it would be in here.
      if (typed === 0 && /password data for new item/i.test(heard)) {
        child.stdin.write(`${secret}\n`)
        typed = 1
        heard = ''
      } else if (typed === 1 && /retype password/i.test(heard)) {
        child.stdin.write(`${secret}\n`)
        typed = 2
        heard = ''
      }
    })
    // What the shell, cat and script(1) themselves say. The terminal's side (the prompts, and anything echoed) is in `heard` and is never shown.
    child.stderr.on('data', (chunk: Buffer) => (complaint += chunk.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    // The input stays open until script(1) has gone: closing it right after the last line can take that line with it.
    child.on('exit', (code) => {
      clearTimeout(timer)
      child.stdin.end()
      if (code === 0 && typed === 2) resolve()
      else reject(new Error(`security exited ${code} for ${service} after ${typed} password prompt(s)${complaint.trim() ? `: ${complaint.trim().slice(0, 200)}` : ''}`))
    })
  })
}

/** The secret in the Keychain, or null when there is no such item. Never printed by this file. */
export function readSecret(service: string, account: string): string | null {
  const r = spawnSync('security', ['find-generic-password', '-a', account, '-s', service, '-w'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.replace(/\r?\n$/, '') : null
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' && !process.env.KEYCHAIN_ALLOW_ANY_OS) throw new Error('this copies into the macOS Keychain')
  const checkOnly = process.argv[2] === 'check'
  const { found, missing } = entries()
  for (const file of missing) console.log(`  skipped: ${file} does not exist`)
  let bad = 0
  for (const e of found) {
    if (!checkOnly) await saveSecret(e.service, e.account, e.secret, e.note)
    const stored = readSecret(e.service, e.account)
    const same = stored === e.secret
    if (!same) bad++
    console.log(`  ${same ? 'ok     ' : 'MISMATCH'} ${e.service}  (${e.account.slice(0, 12)}…)${stored === null ? '  not in the Keychain' : same ? '' : '  differs from the file'}`)
  }
  if (!found.length) throw new Error('no key file found: nothing to copy')
  if (bad) throw new Error(`${bad} item(s) do not match their file`)
  console.log(checkOnly ? '\nevery item in the Keychain matches its file' : '\nsaved and read back: every item matches its file. Login Keychain only (not synced); keep an offline copy as well.')
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR', e?.message ?? e)
    process.exit(1)
  })
}
