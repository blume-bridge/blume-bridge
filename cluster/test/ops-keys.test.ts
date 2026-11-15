import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { ECDSA, Wallet } from 'xrpl'
import { checkKeyFile } from '../scripts/keys-check'
import { PKG, cleanupTmp, makeVolume, run, tmpDir } from './ops-helpers'

/**
 * keys-backup.sh and keys-restore.sh against a fake volume, with a THROWAWAY gpg keyring (a fresh GNUPGHOME, never
 * the user's) and real but disposable key material. age is not installed everywhere, so the age path is exercised
 * through a double that records how it was called.
 */
afterAll(() => {
  for (const home of gnupgHomes) {
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'all'])
    fs.rmSync(home, { recursive: true, force: true })
  }
  cleanupTmp()
})

const BACKUP = path.join(PKG, 'scripts/keys-backup.sh')
const RESTORE = path.join(PKG, 'scripts/keys-restore.sh')
const haveGpg = spawnSync('gpg', ['--version']).status === 0 && spawnSync('jq', ['--version']).status === 0

const gnupgHomes: string[] = []
/** A keyring of its own with one passphrase-less encryption key. Short path: gpg-agent sockets have a length limit. */
function throwawayKeyring(): { home: string; fingerprint: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'g-'))
  fs.chmodSync(home, 0o700)
  gnupgHomes.push(home)
  const env = { ...process.env, GNUPGHOME: home }
  const gen = spawnSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'ops test <ops-test@example.invalid>', 'default', 'default', 'never'], { env, encoding: 'utf8' })
  if (gen.status !== 0) throw new Error(`gpg could not make a throwaway key: ${gen.stderr}`)
  const list = spawnSync('gpg', ['--batch', '--with-colons', '--list-keys'], { env, encoding: 'utf8' }).stdout
  const fingerprint = list.split('\n').find((l) => l.startsWith('fpr:'))!.split(':')[9]
  return { home, fingerprint }
}

interface Real {
  seed: string
  privateKey: string
  doc: { xrpl: { seed: string; address: string; publicKey: string }; evm: { privateKey: string; address: string }; createdAt: number }
}
function realKeys(): Real {
  const w = Wallet.generate()
  const pk = generatePrivateKey()
  return { seed: w.seed!, privateKey: pk, doc: { xrpl: { seed: w.seed!, address: w.classicAddress, publicKey: w.publicKey }, evm: { privateKey: pk, address: privateKeyToAddress(pk) }, createdAt: Date.now() } }
}

interface World {
  root: string
  volRoot: string
  keys: Map<number, Real>
  seedDir(n: number): string
  stage: string
}
function world(nodes: number, withKeys: number[], payout: number[] = []): World {
  const root = tmpDir()
  const vol = makeVolume(root, 'main', { nodes, keys: [], payout })
  const keys = new Map<number, Real>()
  for (const n of withKeys) {
    const k = realKeys()
    keys.set(n, k)
    fs.writeFileSync(path.join(vol.seedDir(n), 'bridge-keys.json'), JSON.stringify(k.doc), { mode: 0o600 })
  }
  const stage = path.join(root, 'stage')
  fs.mkdirSync(stage)
  return { root, volRoot: vol.volRoot, keys, seedDir: vol.seedDir, stage }
}
const secretsOf = (w: World) => [...w.keys.values()].flatMap((k) => [k.seed, k.privateKey])
const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const modeOf = (p: string) => fs.statSync(p).mode & 0o777

function backupEnv(w: World, ring: { home: string; fingerprint: string } | null, extra: Record<string, string | undefined> = {}) {
  return { CLUSTER: 'main', VOL_ROOT: w.volRoot, STAGE_ROOT: w.stage, ...(ring ? { GNUPGHOME: ring.home, BACKUP_RECIPIENT: ring.fingerprint, BACKUP_TOOL: 'gpg' } : {}), ...extra }
}

describe.skipIf(!haveGpg)('keys-backup.sh and keys-restore.sh: the gpg round trip', () => {
  // A suite that is skipped still runs its body to collect the tests, so do not touch gpg when it is missing.
  const ring = haveGpg ? throwawayKeyring() : { home: '', fingerprint: '' }

  it('backs up five nodes to one encrypted file and prints addresses and a hash, never a key', () => {
    const w = world(5, [1, 2, 3, 4, 5], [2, 5])
    const out = path.join(w.root, 'bridge-keys.tar.gpg')
    const r = run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: out }) })
    expect(r.status, r.out).toBe(0)
    expect(fs.existsSync(out)).toBe(true)
    expect(modeOf(out)).toBe(0o600)
    expect(r.out).toContain(`sha256: ${sha256(out)}`)
    for (const [n, k] of w.keys) {
      expect(r.out).toContain(`node ${n}  xrpl ${k.doc.xrpl.address}  evm ${k.doc.evm.address}`)
    }
    expect(r.out).toMatch(/node 2 .*payout file yes/)
    expect(r.out).toMatch(/node 1 .*payout file no/)
    expect(r.out).toContain(ring.fingerprint)
    for (const s of secretsOf(w)) {
      expect(r.out).not.toContain(s)
      expect(fs.readFileSync(out).includes(Buffer.from(s))).toBe(false)
    }
    // no plaintext staging left behind, and no partial file
    expect(fs.readdirSync(w.stage)).toEqual([])
    expect(fs.existsSync(`${out}.partial`)).toBe(false)
  })

  it('--verify opens it with the private key, checks every key against its address and writes nothing', () => {
    const w = world(5, [1, 2, 3, 4, 5], [3])
    const out = path.join(w.root, 'b.tar.gpg')
    expect(run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: out }) }).status).toBe(0)
    const r = run('bash', [RESTORE, '--verify', out], { env: { GNUPGHOME: ring.home, STAGE_ROOT: w.stage, CLUSTER_SIZE: '5' } })
    expect(r.status, r.out).toBe(0)
    for (const [n, k] of w.keys) expect(r.out).toContain(`node ${n}  xrpl ${k.doc.xrpl.address}  evm ${k.doc.evm.address}`)
    expect(r.out).toMatch(/5 node\(s\): every seed and private key derives the address on record/)
    expect(r.out).toMatch(/Nothing was written/)
    for (const s of secretsOf(w)) expect(r.out).not.toContain(s)
    expect(fs.readdirSync(w.stage)).toEqual([])
    // DRY_RUN=1 is the same thing
    const dry = run('bash', [RESTORE, out], { env: { GNUPGHOME: ring.home, STAGE_ROOT: w.stage, DRY_RUN: '1' } })
    expect(dry.status, dry.out).toBe(0)
    expect(dry.out).toMatch(/Nothing was written/)
  })

  it('restores into the layout deploy-dev.sh expects, byte for byte, mode 600', () => {
    const w = world(5, [1, 2, 3, 4, 5], [2, 5])
    const out = path.join(w.root, 'b.tar.gpg')
    expect(run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: out }) }).status).toBe(0)
    const dest = path.join(w.root, 'restored')
    const r = run('bash', [RESTORE, out, '--out', dest], { env: { GNUPGHOME: ring.home, STAGE_ROOT: w.stage } })
    expect(r.status, r.out).toBe(0)
    expect(modeOf(dest)).toBe(0o700)
    for (let n = 1; n <= 5; n++) {
      const file = path.join(dest, `node${n}`, 'contract_fs', 'seed', 'bridge-keys.json')
      expect(fs.readFileSync(file, 'utf8')).toBe(fs.readFileSync(path.join(w.seedDir(n), 'bridge-keys.json'), 'utf8'))
      expect(modeOf(file)).toBe(0o600)
    }
    for (const n of [2, 5]) expect(fs.readFileSync(path.join(dest, `node${n}`, 'contract_fs', 'seed', 'bridge-payout.json'), 'utf8')).toBe(fs.readFileSync(path.join(w.seedDir(n), 'bridge-payout.json'), 'utf8'))
    expect(fs.existsSync(path.join(dest, 'node1', 'contract_fs', 'seed', 'bridge-payout.json'))).toBe(false)
    expect(r.out).toContain('PLAINTEXT')
    for (const s of secretsOf(w)) expect(r.out).not.toContain(s)
    expect(fs.readdirSync(w.stage)).toEqual([])
    // it will not write over an existing directory that has something in it
    const again = run('bash', [RESTORE, out, '--out', dest], { env: { GNUPGHOME: ring.home, STAGE_ROOT: w.stage } })
    expect(again.status).toBe(1)
    expect(again.out).toMatch(/not empty/)
  })

  it('refuses to write without a recipient, in either tool, and writes nothing', () => {
    const w = world(3, [1, 2, 3])
    const out = path.join(w.root, 'none.tar.gpg')
    const r = run('bash', [BACKUP], { env: backupEnv(w, null, { BACKUP_OUT: out, BACKUP_TOOL: 'gpg' }) })
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/no recipient/)
    expect(r.out).toMatch(/no passphrase mode/)
    expect(fs.existsSync(out)).toBe(false)
    const age = run('bash', [BACKUP], { env: backupEnv(w, null, { BACKUP_OUT: out, BACKUP_TOOL: 'age' }) })
    expect(age.status).toBe(2)
    expect(fs.existsSync(out)).toBe(false)
    expect(fs.readdirSync(w.root).filter((f) => f.includes('bridge-keys'))).toEqual([])
  })

  it('names the node and stops when one has no key file, and says so when it is allowed to be missing', () => {
    const w = world(5, [1, 2, 3, 5])
    const out = path.join(w.root, 'b.tar.gpg')
    const refused = run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: out }) })
    expect(refused.status).toBe(1)
    expect(refused.out).toMatch(/node 4 has no key file/)
    expect(fs.existsSync(out)).toBe(false)
    const allowed = run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: out, ALLOW_MISSING_NODES: '4' }) })
    expect(allowed.status, allowed.out).toBe(0)
    expect(allowed.out).toMatch(/4 of 5 node\(s\) covered/)
    expect(allowed.out).toMatch(/node\(s\) 4 are NOT in this backup/)
    // a bundle that leaves a node out cannot restore a cluster that expects five
    const short = run('bash', [RESTORE, '--verify', out], { env: { GNUPGHOME: ring.home, STAGE_ROOT: w.stage, CLUSTER_SIZE: '5' } })
    expect(short.status).toBe(1)
    expect(short.out).toMatch(/covers 4 node\(s\) but CLUSTER_SIZE=5/)
  })

  it('refuses a file that is not a bridge key file', () => {
    const w = world(3, [1, 2, 3])
    fs.writeFileSync(path.join(w.seedDir(2), 'bridge-keys.json'), JSON.stringify({ note: 'not keys' }))
    const r = run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: path.join(w.root, 'b.tar.gpg') }) })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/node 2: .* is not a bridge key file/)
  })

  it('never overwrites an existing backup', () => {
    const w = world(3, [1, 2, 3])
    const out = path.join(w.root, 'b.tar.gpg')
    fs.writeFileSync(out, 'precious')
    const r = run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: out }) })
    expect(r.status).toBe(1)
    expect(fs.readFileSync(out, 'utf8')).toBe('precious')
  })

  it('only takes a full gpg fingerprint that is in the keyring', () => {
    const w = world(3, [1, 2, 3])
    const out = path.join(w.root, 'b.tar.gpg')
    for (const bad of ['ops-test@example.invalid', ring.fingerprint.slice(-16), 'AAAA'.repeat(10)]) {
      const r = run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: out, BACKUP_RECIPIENT: bad }) })
      expect(r.status, bad).not.toBe(0)
      expect(fs.existsSync(out)).toBe(false)
    }
  })

  it('a bundle that cannot be opened with this key, or was damaged, is refused', () => {
    const w = world(3, [1, 2, 3])
    const out = path.join(w.root, 'b.tar.gpg')
    expect(run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: out }) }).status).toBe(0)
    const stranger = throwawayKeyring()
    const wrong = run('bash', [RESTORE, '--verify', out], { env: { GNUPGHOME: stranger.home, STAGE_ROOT: w.stage } })
    expect(wrong.status).toBe(1)
    expect(wrong.out).toMatch(/could not open the bundle/)
    const bytes = fs.readFileSync(out)
    bytes[bytes.length - 20] ^= 0xff
    const damaged = path.join(w.root, 'damaged.tar.gpg')
    fs.writeFileSync(damaged, bytes)
    const r = run('bash', [RESTORE, '--verify', damaged], { env: { GNUPGHOME: ring.home, STAGE_ROOT: w.stage } })
    expect(r.status).toBe(1)
    expect(fs.readdirSync(w.stage)).toEqual([])
  })

  it('catches a key that does not belong to its address', () => {
    const w = world(3, [1, 2, 3])
    const doc = JSON.parse(fs.readFileSync(path.join(w.seedDir(2), 'bridge-keys.json'), 'utf8'))
    doc.evm.address = privateKeyToAddress(generatePrivateKey())
    fs.writeFileSync(path.join(w.seedDir(2), 'bridge-keys.json'), JSON.stringify(doc))
    const out = path.join(w.root, 'b.tar.gpg')
    expect(run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: out }) }).status).toBe(0)
    const r = run('bash', [RESTORE, '--verify', out], { env: { GNUPGHOME: ring.home, STAGE_ROOT: w.stage } })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/node 2 .*MISMATCH/)
    expect(r.out).toMatch(/the evm key derives/)
    for (const s of secretsOf(w)) expect(r.out).not.toContain(s)
  })

  it('refuses a bundle with paths or links a backup never has', () => {
    const w = world(1, [1])
    const build = path.join(w.root, 'evil')
    fs.mkdirSync(path.join(build, 'node1', 'contract_fs', 'seed'), { recursive: true })
    fs.writeFileSync(path.join(build, 'manifest.json'), JSON.stringify({ format: 'blume-bridge-keys/1', nodes: [] }))
    fs.writeFileSync(path.join(build, 'node1', 'contract_fs', 'seed', 'surprise.sh'), 'echo hi')
    const tar = spawnSync('tar', ['-cf', '-', '-C', build, 'manifest.json', 'node1'])
    const enc = spawnSync('gpg', ['--batch', '--yes', '--trust-model', 'always', '--encrypt', '--recipient', ring.fingerprint, '--output', path.join(w.root, 'evil.tar.gpg')], { env: { ...process.env, GNUPGHOME: ring.home }, input: tar.stdout })
    expect(enc.status).toBe(0)
    const r = run('bash', [RESTORE, '--verify', path.join(w.root, 'evil.tar.gpg')], { env: { GNUPGHOME: ring.home, STAGE_ROOT: w.stage } })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/paths a backup never does/)
    expect(r.out).toContain('surprise.sh')
  })

  it('DRY_RUN prints the plan and writes nothing', () => {
    const w = world(5, [1, 2, 3, 4, 5])
    const out = path.join(w.root, 'b.tar.gpg')
    const r = run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: out, DRY_RUN: '1' }) })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/DRY_RUN=1/)
    expect(r.out).toMatch(/\+ tar -cf - -C <stage> manifest\.json node1 node2 node3 node4 node5 \| /)
    expect(r.out).toContain('--recipient')
    expect(fs.existsSync(out)).toBe(false)
    expect(fs.readdirSync(w.stage)).toEqual([])
    for (const s of secretsOf(w)) expect(r.out).not.toContain(s)
  })

  it('takes the node count from CLUSTER_SIZE or from the directories, for any n', () => {
    const w = world(7, [1, 2, 3, 4, 5, 6, 7])
    const out = path.join(w.root, 'b.tar.gpg')
    const r = run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: out }) })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/7 of 7 node\(s\) covered/)
    const sized = run('bash', [BACKUP], { env: backupEnv(w, ring, { BACKUP_OUT: path.join(w.root, 'c.tar.gpg'), CLUSTER_SIZE: '3' }) })
    expect(sized.out).toMatch(/3 of 3 node\(s\) covered/)
  })
})

describe('keys-backup.sh with age (a double that records how it was called)', () => {
  function ageDouble(root: string): { bin: string; log: string } {
    const bin = path.join(root, 'age')
    const log = path.join(root, 'age.log')
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; esac; shift; done
{ printf 'AGE-DOUBLE\\n'; cat; } > "$out"
`,
      { mode: 0o755 },
    )
    return { bin, log }
  }
  const pub = 'age1' + 'q'.repeat(58)
  const haveJq = spawnSync('jq', ['--version']).status === 0

  it.skipIf(!haveJq)('encrypts to the recipient given, with -r and -o, and never asks for a passphrase', () => {
    const w = world(3, [1, 2, 3])
    const age = ageDouble(w.root)
    const out = path.join(w.root, 'b.tar.age')
    const r = run('bash', [BACKUP], { env: { CLUSTER: 'main', VOL_ROOT: w.volRoot, STAGE_ROOT: w.stage, BACKUP_TOOL: 'age', AGE_BIN: age.bin, BACKUP_RECIPIENT: pub, BACKUP_OUT: out } })
    expect(r.status, r.out).toBe(0)
    const calls = fs.readFileSync(age.log, 'utf8').trim().split('\n')
    expect(calls).toEqual([`-r ${pub} -o ${out}.partial`])
    expect(calls[0]).not.toMatch(/(^| )-p( |$)|passphrase/)
    expect(fs.readFileSync(out, 'latin1').startsWith('AGE-DOUBLE')).toBe(true)
    expect(r.out).toContain(pub)
    for (const s of secretsOf(w)) expect(r.out).not.toContain(s)
  })

  it.skipIf(!haveJq)('refuses an age private key as the recipient, and a gpg fingerprint when age is the tool', () => {
    const w = world(3, [1, 2, 3])
    const age = ageDouble(w.root)
    const base = { CLUSTER: 'main', VOL_ROOT: w.volRoot, STAGE_ROOT: w.stage, BACKUP_TOOL: 'age', AGE_BIN: age.bin, BACKUP_OUT: path.join(w.root, 'b.tar.age') }
    const priv = run('bash', [BACKUP], { env: { ...base, BACKUP_RECIPIENT: 'AGE-SECRET-KEY-1' + 'Q'.repeat(58) } })
    expect(priv.status).toBe(2)
    expect(priv.out).toMatch(/PRIVATE key/)
    expect(priv.out).not.toContain('QQQQQQQQ')
    const fpr = run('bash', [BACKUP], { env: { ...base, BACKUP_RECIPIENT: 'A'.repeat(40) } })
    expect(fpr.status).toBe(2)
    expect(fs.existsSync(path.join(w.root, 'age.log'))).toBe(false)
    expect(fs.existsSync(base.BACKUP_OUT)).toBe(false)
  })

  it.skipIf(!haveJq)('takes several recipients and a recipients file', () => {
    const w = world(3, [1, 2, 3])
    const age = ageDouble(w.root)
    const file = path.join(w.root, 'recipients.txt')
    fs.writeFileSync(file, `# the hardware key\n${pub}\n`)
    const out = path.join(w.root, 'b.tar.age')
    const other = 'age1' + 'p'.repeat(58)
    const r = run('bash', [BACKUP], { env: { CLUSTER: 'main', VOL_ROOT: w.volRoot, STAGE_ROOT: w.stage, BACKUP_TOOL: 'age', AGE_BIN: age.bin, BACKUP_RECIPIENT: `${pub}, ${other}`, BACKUP_RECIPIENTS_FILE: file, BACKUP_OUT: out } })
    expect(r.status, r.out).toBe(0)
    expect(fs.readFileSync(age.log, 'utf8').trim()).toBe(`-r ${pub} -r ${other} -R ${file} -o ${out}.partial`)
  })

  it.skipIf(!haveJq)('restore opens an age bundle with -d -i and the identity file', () => {
    const w = world(3, [1, 2, 3])
    const age = ageDouble(w.root)
    const out = path.join(w.root, 'b.tar.age')
    expect(run('bash', [BACKUP], { env: { CLUSTER: 'main', VOL_ROOT: w.volRoot, STAGE_ROOT: w.stage, BACKUP_TOOL: 'age', AGE_BIN: age.bin, BACKUP_RECIPIENT: pub, BACKUP_OUT: out } }).status).toBe(0)
    // a decrypting double: drop the marker line, write the tar
    const dec = path.join(w.root, 'age-dec')
    fs.writeFileSync(dec, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(path.join(w.root, 'dec.log'))}\nfile="\${@: -1}"\ntail -n +2 "$file"\n`, { mode: 0o755 })
    const identity = path.join(w.root, 'identity.txt')
    fs.writeFileSync(identity, '# a placeholder\n')
    const r = run('bash', [RESTORE, '--verify', out], { env: { AGE_BIN: dec, AGE_IDENTITY: identity, STAGE_ROOT: w.stage } })
    expect(r.status, r.out).toBe(0)
    expect(fs.readFileSync(path.join(w.root, 'dec.log'), 'utf8').trim()).toBe(`-d -i ${identity} ${out}`)
    const missing = run('bash', [RESTORE, '--verify', out], { env: { AGE_BIN: dec, STAGE_ROOT: w.stage } })
    expect(missing.status).toBe(1)
    expect(missing.out).toMatch(/AGE_IDENTITY/)
  })
})

describe('checkKeyFile: a key is the key it says it is', () => {
  it('passes real key material, for either XRPL algorithm', () => {
    const k = realKeys()
    expect(checkKeyFile(k.doc)).toEqual({ xrplAddress: k.doc.xrpl.address, evmAddress: k.doc.evm.address, errors: [] })
    const secp = Wallet.generate(ECDSA.secp256k1)
    const doc = { ...k.doc, xrpl: { seed: secp.seed!, address: secp.classicAddress, publicKey: secp.publicKey } }
    expect(checkKeyFile(doc).errors).toEqual([])
  })

  it('names a mismatch without repeating a secret', () => {
    const k = realKeys()
    const other = realKeys()
    const wrongXrpl = checkKeyFile({ ...k.doc, xrpl: { ...k.doc.xrpl, address: other.doc.xrpl.address } })
    expect(wrongXrpl.errors).toHaveLength(1)
    expect(wrongXrpl.errors[0]).toMatch(/the xrpl seed derives r\w+, not the recorded r\w+/)
    const wrongEvm = checkKeyFile({ ...k.doc, evm: { ...k.doc.evm, address: other.doc.evm.address } })
    expect(wrongEvm.errors[0]).toMatch(/the evm key derives 0x/)
    for (const e of [...wrongXrpl.errors, ...wrongEvm.errors]) {
      expect(e).not.toContain(k.seed)
      expect(e).not.toContain(k.privateKey)
    }
  })

  it('reports garbage as garbage, not as a crash and not with the garbage in the message', () => {
    const r = checkKeyFile({ xrpl: { seed: 'sNOTASEEDATALLNOTASEED', address: 'rX', publicKey: 'p' }, evm: { privateKey: '0xnothex', address: '0x1' } })
    expect(r.errors).toEqual(['the xrpl seed does not decode', 'the evm private key does not decode'])
    expect(checkKeyFile({}).errors).toEqual(['the xrpl seed or address is missing', 'the evm private key or address is missing'])
    expect(checkKeyFile(null).errors).toHaveLength(2)
  })
})
