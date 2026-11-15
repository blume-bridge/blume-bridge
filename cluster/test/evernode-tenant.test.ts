import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Wallet } from 'xrpl'
import { fundingNeeded } from '../scripts/evernode-tenant'
import { PKG, cleanupTmp, run, tmpDir } from './ops-helpers'

/**
 * The tenant wallet script makes a Xahau account whose seed pays every lease. The seed must reach the file and nowhere else:
 * not the terminal, not a log, and the file is never overwritten.
 */
afterAll(cleanupTmp)

const tenant = (file: string, ...args: string[]) => run('npx', ['tsx', 'scripts/evernode-tenant.ts', ...args], { cwd: PKG, env: { TENANT_FILE: file } })

describe('evernode-tenant new', () => {
  it('saves an ed25519 seed that reproduces the printed address, readable by its owner only, and prints no seed', () => {
    const file = path.join(tmpDir('tenant-'), 'keys', 'evernode-tenant.txt')
    const r = tenant(file, 'new')
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/tenant wallet made: r[1-9A-HJ-NP-Za-km-z]{24,34}/)
    const body = fs.readFileSync(file, 'utf8')
    const address = /^address=(\S+)$/m.exec(body)![1]
    const seed = /^seed=(\S+)$/m.exec(body)![1]
    expect(seed.startsWith('sEd')).toBe(true)
    expect(Wallet.fromSeed(seed).classicAddress).toBe(address)
    expect(r.out).not.toContain(seed)
    expect(r.out).not.toMatch(/\bsEd[1-9A-HJ-NP-Za-km-z]{20,}/)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    // the file is the format scripts/evernode-cluster.sh greps
    expect(body).toMatch(/^address=r\S+\nseed=sEd\S+\ncreated=\d{4}-/)
  }, 60_000)

  it('never overwrites a wallet, and names the existing address instead', () => {
    const file = path.join(tmpDir('tenant-'), 'keys', 'evernode-tenant.txt')
    expect(tenant(file, 'new').status).toBe(0)
    const before = fs.readFileSync(file, 'utf8')
    const again = tenant(file, 'new')
    expect(again.status).toBe(1)
    expect(again.out).toMatch(/already exists and is never overwritten/)
    expect(again.out).toContain(/^address=(\S+)$/m.exec(before)![1])
    expect(again.out).not.toContain(/^seed=(\S+)$/m.exec(before)![1])
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  }, 60_000)

  it('refuses trust without --yes, before reading the seed or touching the network', () => {
    const file = path.join(tmpDir('tenant-'), 'keys', 'evernode-tenant.txt')
    tenant(file, 'new')
    const r = tenant(file, 'trust')
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/Add --yes/)
  }, 60_000)
})

describe('how much to fund', () => {
  it('covers the reserves, a trust line, one URIToken per instance and the lease with room to spare', () => {
    // 3 instances for 720 moments at 0.01 EVR per moment
    const n = fundingNeeded({ instances: 3, moments: 720, leasePerMoment: 0.01, baseReserve: 1, ownerReserve: 0.2 })
    expect(n.evr).toBeCloseTo(27, 5) // 21.6 * 1.25
    expect(n.xah).toBe(Math.ceil(1 + 0.2 * 4 + 5))
  })
})
