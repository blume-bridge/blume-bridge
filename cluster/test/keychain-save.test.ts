import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PKG, cleanupTmp, run, tmpDir } from './ops-helpers'

/**
 * The Keychain copy runs against a stand-in for `security` that asks for the password the way the real one does (at the
 * terminal, twice) and keeps what it is given in a folder. The real Keychain is never touched. What matters: every secret
 * reaches the store, a second run updates instead of failing, and no secret appears in an argument or in the output.
 */
afterAll(cleanupTmp)

const SECRETS = {
  lock: 'sEdLOCKSEEDdummy111111111111111',
  funding: 'sEdFUNDINGSEEDdummy2222222222222',
  tenant: 'sEdTENANTSEEDdummy33333333333333',
  admin: 'c0ffee'.repeat(10) + 'abcd', // the seed half; the whole key is ed + seed + public key
  upgrade: 'badf00'.repeat(10) + 'abcd',
}

const FAKE_SECURITY = `#!/bin/bash
echo "$@" >> "$FAKE_KEYCHAIN.argv"
cmd="$1"; shift
acct=""; svc=""
while [ $# -gt 0 ]; do case "$1" in -a) acct="$2"; shift;; -s) svc="$2"; shift;; esac; shift; done
mkdir -p "$FAKE_KEYCHAIN"
if [ "$cmd" = add-generic-password ]; then
  # like the real prompt: the terminal is set up (echo off) before the prompt is shown, so input typed at the prompt cannot arrive early
  stty -echo < /dev/tty
  printf 'password data for new item: ' > /dev/tty
  read -r pw < /dev/tty
  printf '\\nretype password for new item: ' > /dev/tty
  read -r pw2 < /dev/tty
  stty echo < /dev/tty
  [ "$pw" = "$pw2" ] || exit 1
  printf '%s' "$pw" > "$FAKE_KEYCHAIN/$svc.$acct"
elif [ "$cmd" = find-generic-password ]; then
  [ -f "$FAKE_KEYCHAIN/$svc.$acct" ] || exit 44
  cat "$FAKE_KEYCHAIN/$svc.$acct"; echo
fi
`

function world() {
  const dir = tmpDir('keychain-')
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'security'), FAKE_SECURITY, { mode: 0o755 })
  const keys = path.join(dir, 'keys')
  fs.mkdirSync(keys)
  const files = {
    mainnet: path.join(keys, 'mainnet.json'),
    tenant: path.join(keys, 'evernode-tenant.txt'),
    admin: path.join(keys, 'admin-mainnet.json'),
    upgrade: path.join(keys, 'upgrade-mainnet.json'),
  }
  fs.writeFileSync(files.mainnet, JSON.stringify({ lock: { address: 'rLockAddr', seed: SECRETS.lock }, funding: { address: 'rFundingAddr', seed: SECRETS.funding } }))
  fs.writeFileSync(files.tenant, `address=rTenantAddr\nseed=${SECRETS.tenant}\ncreated=2026-10-17T00:00:00Z\n`)
  fs.writeFileSync(files.admin, JSON.stringify({ privateKeyHex: `ed${SECRETS.admin}${'d'.repeat(64)}`, publicKeyHex: `ed${'d'.repeat(64)}` }))
  fs.writeFileSync(files.upgrade, JSON.stringify({ privateKeyHex: `ed${SECRETS.upgrade}${'e'.repeat(64)}`, publicKeyHex: `ed${'e'.repeat(64)}` }))
  const store = path.join(dir, 'store')
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_KEYCHAIN: store, KEYCHAIN_PREFIX: 'blume-test', KEYS_PATH: files.mainnet, TENANT_FILE: files.tenant, ADMIN_KEY_FILE: files.admin, UPGRADE_KEY_FILE: files.upgrade }
  const keychain = (...args: string[]) => run('npx', ['tsx', 'scripts/keychain-save.ts', ...args], { cwd: PKG, env })
  return { dir, store, files, keychain }
}

describe.skipIf(process.platform !== 'darwin')('keychain-save', () => {
  it('stores every secret under its own service and account, and never shows one', () => {
    const w = world()
    const r = w.keychain()
    expect(r.status, r.out).toBe(0)
    const kept = (service: string, account: string) => fs.readFileSync(path.join(w.store, `${service}.${account}`), 'utf8')
    expect(kept('blume-test-mainnet-lock-seed', 'rLockAddr')).toBe(SECRETS.lock)
    expect(kept('blume-test-mainnet-funding-seed', 'rFundingAddr')).toBe(SECRETS.funding)
    expect(kept('blume-test-evernode-tenant-seed', 'rTenantAddr')).toBe(SECRETS.tenant)
    expect(kept('blume-test-admin-mainnet-key', `ed${'d'.repeat(64)}`)).toBe(SECRETS.admin)
    expect(kept('blume-test-upgrade-mainnet-key', `ed${'e'.repeat(64)}`)).toBe(SECRETS.upgrade)
    expect(r.out).toMatch(/saved and read back: every item matches its file/)
    // nothing secret in the output, and nothing secret in anything `security` was handed as an argument
    const argv = fs.readFileSync(`${w.store}.argv`, 'utf8')
    for (const secret of Object.values(SECRETS)) {
      expect(r.out).not.toContain(secret)
      expect(argv).not.toContain(secret)
    }
    expect(argv).toContain('add-generic-password')
  }, 90_000)

  it('updates an item that is already there, and check agrees with the files', () => {
    const w = world()
    expect(w.keychain().status).toBe(0)
    const again = w.keychain()
    expect(again.status, again.out).toBe(0)
    const check = w.keychain('check')
    expect(check.status, check.out).toBe(0)
    expect(check.out).toMatch(/every item in the Keychain matches its file/)
  }, 90_000)

  it('check names an item whose file has changed since, and exits 1', () => {
    const w = world()
    expect(w.keychain().status).toBe(0)
    fs.writeFileSync(w.files.tenant, 'address=rTenantAddr\nseed=sEdSOMETHINGELSE\n')
    const check = w.keychain('check')
    expect(check.status).toBe(1)
    expect(check.out).toMatch(/MISMATCH blume-test-evernode-tenant-seed/)
    expect(check.out).not.toContain('sEdSOMETHINGELSE')
    expect(check.out).not.toContain(SECRETS.tenant)
  }, 90_000)

  it('puts a note on the operator key saying how to rebuild the whole key, and refuses a key it cannot split or a secret too long for the prompt', () => {
    const w = world()
    expect(w.keychain().status).toBe(0)
    expect(fs.readFileSync(`${w.store}.argv`, 'utf8')).toMatch(/-j seed half of the HotPocket private key/)
    // a private key whose tail is not its public key
    fs.writeFileSync(w.files.admin, JSON.stringify({ privateKeyHex: `ed${SECRETS.admin}${'e'.repeat(64)}`, publicKeyHex: `ed${'d'.repeat(64)}` }))
    const odd = w.keychain()
    expect(odd.status).toBe(1)
    expect(odd.out).toMatch(/is not an ed \+ seed \+ public key pair/)
    // a tenant seed too long to type at a prompt
    fs.writeFileSync(w.files.admin, JSON.stringify({ privateKeyHex: `ed${SECRETS.admin}${'d'.repeat(64)}`, publicKeyHex: `ed${'d'.repeat(64)}` }))
    fs.writeFileSync(w.files.tenant, `address=rTenantAddr\nseed=${'s'.repeat(200)}\n`)
    const long = w.keychain()
    expect(long.status).toBe(1)
    expect(long.out).toMatch(/is 200 characters; a terminal prompt takes 120/)
  }, 90_000)

  it('skips a key file that does not exist and says so, and fails when there is nothing at all', () => {
    const w = world()
    fs.rmSync(w.files.admin)
    const r = w.keychain()
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/skipped: .*admin-mainnet\.json does not exist/)
    expect(fs.readdirSync(w.store).filter((f) => f.startsWith('blume-test-'))).toHaveLength(4)
    for (const f of [w.files.mainnet, w.files.tenant, w.files.upgrade]) fs.rmSync(f)
    const none = w.keychain()
    expect(none.status).toBe(1)
    expect(none.out).toMatch(/no key file found/)
  }, 90_000)
})
