import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Wallet } from 'xrpl'
import { accountNeeds } from '../scripts/mainnet-accounts'
import { PKG, cleanupTmp, run, tmpDir } from './ops-helpers'

/**
 * The mainnet accounts script makes the lock and funding accounts whose master keys hold everything until the SignerList is on.
 * The seeds must reach the file and nowhere else: not the terminal, not a log, and the file is never overwritten.
 */
afterAll(cleanupTmp)

const accounts = (file: string, ...args: string[]) => run('npx', ['tsx', 'scripts/mainnet-accounts.ts', ...args], { cwd: PKG, env: { KEYS_PATH: file } })

describe('mainnet-accounts new', () => {
  it('saves two ed25519 seeds that reproduce their addresses, readable by the owner only, and prints no seed', () => {
    const file = path.join(tmpDir('mainnet-accounts-'), 'keys', 'mainnet.json')
    const r = accounts(file, 'new')
    expect(r.status, r.out).toBe(0)
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<'lock' | 'funding', { address: string; seed: string }>
    // the shape testnet-signerlist.ts reads
    expect(Object.keys(body).sort()).toEqual(['funding', 'lock'])
    expect(body.lock.address).not.toBe(body.funding.address)
    expect(body.lock.seed).not.toBe(body.funding.seed)
    for (const role of ['lock', 'funding'] as const) {
      expect(body[role].seed.startsWith('sEd')).toBe(true)
      expect(Wallet.fromSeed(body[role].seed).classicAddress).toBe(body[role].address)
      expect(r.out).toContain(body[role].address)
      expect(r.out).not.toContain(body[role].seed)
    }
    expect(r.out).not.toMatch(/\bsEd[1-9A-HJ-NP-Za-km-z]{20,}/)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  }, 60_000)

  it('never overwrites the accounts, and names the existing addresses instead of the seeds', () => {
    const file = path.join(tmpDir('mainnet-accounts-'), 'keys', 'mainnet.json')
    expect(accounts(file, 'new').status).toBe(0)
    const before = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(before) as Record<'lock' | 'funding', { address: string; seed: string }>
    const again = accounts(file, 'new')
    expect(again.status).toBe(1)
    expect(again.out).toMatch(/already exists and is never overwritten/)
    expect(again.out).toContain(parsed.lock.address)
    expect(again.out).toContain(parsed.funding.address)
    expect(again.out).not.toContain(parsed.lock.seed)
    expect(again.out).not.toContain(parsed.funding.seed)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  }, 60_000)

  it('status without the key file says to make it first, and reads nothing', () => {
    const file = path.join(tmpDir('mainnet-accounts-'), 'keys', 'mainnet.json')
    const r = accounts(file, 'status')
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/run "new" first/)
  }, 60_000)

  it('status refuses a token count that is not a number', () => {
    const file = path.join(tmpDir('mainnet-accounts-'), 'keys', 'mainnet.json')
    expect(accounts(file, 'new').status).toBe(0)
    const r = accounts(file, 'status', '--tokens', 'lots')
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/--tokens is the number of tokens/)
  }, 60_000)
})

describe('how much to fund', () => {
  it('holds a trust line per token and the SignerList on the lock account, and only the SignerList on the funding account', () => {
    const n = accountNeeds({ tokens: 7, baseReserve: 1, ownerReserve: 0.2 })
    expect(n.lock.reserve).toBeCloseTo(2.6, 5) // 1 + 0.2 * (7 + 1)
    expect(n.funding.reserve).toBeCloseTo(1.2, 5) // 1 + 0.2
    // the floor is the reserve and a few XRP of fees; comfortable also leaves room to list more tokens later
    expect(n.lock.floor).toBe(6)
    expect(n.lock.comfortable).toBe(13)
    expect(n.funding.floor).toBe(5)
    expect(n.funding.comfortable).toBe(10)
  })

  it('shrinks with fewer tokens and follows the network reserve', () => {
    expect(accountNeeds({ tokens: 0, baseReserve: 1, ownerReserve: 0.2 }).lock.reserve).toBeCloseTo(1.2, 5)
    expect(accountNeeds({ tokens: 7, baseReserve: 10, ownerReserve: 2 }).lock.reserve).toBeCloseTo(26, 5)
  })
})
