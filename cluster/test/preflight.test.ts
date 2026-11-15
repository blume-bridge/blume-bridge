import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import dev from '../genesis/dev.json'
import { cleanupTmp, runAsync, tmpDir, PKG } from './ops-helpers'

/**
 * The launch gate against a fake XRP Ledger. The review of 2026-10-17 found it passing a lock account with a RegularKey,
 * a run with no --node (so no comparison with the operators at all), and servers that disagreed with each other.
 */
afterAll(cleanupTmp)

interface Fake {
  url: string
  close(): void
}

function fakeLedger(opts: { regularKey?: boolean; hash?: string; networkId?: number; masterOn?: boolean } = {}): Promise<Fake> {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const { method, params } = JSON.parse(body) as { method: string; params: [Record<string, unknown>] }
      const p = params[0]
      let result: Record<string, unknown> = {}
      if (method === 'feature') result = { features: { a: { name: 'BatchV1_1', enabled: true } } }
      else if (method === 'server_info') result = { info: { validated_ledger: { seq: 1000 }, ...(opts.networkId !== undefined ? { network_id: opts.networkId } : {}) } }
      else if (method === 'ledger') result = { ledger_hash: opts.hash ?? 'AAAA' }
      else if (method === 'account_lines') result = { lines: [] }
      else if (method === 'account_info') {
        const isLock = p.account === dev.config.xrpl.lockAccount
        result = {
          account_data: { Balance: '50000000', Flags: opts.masterOn ? 0 : 0x00100000, OwnerCount: 1, ...(isLock && opts.regularKey ? { RegularKey: 'rRegularKeyHolder1111111111111111' } : {}) },
          signer_lists: [{ SignerQuorum: 2, SignerEntries: [1, 2, 3].map((i) => ({ SignerEntry: { Account: `rSigner${i}`, SignerWeight: 1 } })) }],
        }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ result }))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => server.close() })))
}

async function preflight(servers: Fake[], extra: string[] = [], over: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const dir = tmpDir('preflight-')
  const config = { ...dev.config, feed: 'xrpl', evm: undefined, testHooks: false, admins: ['ed' + 'a'.repeat(64)], xrpl: { ...dev.config.xrpl, rpc: servers.map((s) => s.url), network: 'mainnet' }, ...over }
  const file = path.join(dir, 'genesis.json')
  fs.writeFileSync(file, JSON.stringify({ config, tokens: {}, cursor: dev.cursor }))
  return runAsync('npx', ['tsx', 'scripts/preflight.ts', ...extra], { env: { XRPL_NETWORK: 'mainnet', PREFLIGHT_GENESIS: file, ...env }, cwd: PKG })
}

describe('preflight on mainnet', () => {
  it('fails a lock account that has a regular key, and passes one that has none', async () => {
    const bad = await fakeLedger({ regularKey: true })
    const good = await fakeLedger()
    const withKey = await preflight([bad, await fakeLedger({ regularKey: true })])
    const without = await preflight([good, await fakeLedger()])
    bad.close()
    good.close()
    expect(withKey.out).toMatch(/FAIL lock account has no regular key/)
    expect(without.out).toMatch(/ok\s+lock account has no regular key/)
    expect(without.out).not.toMatch(/FAIL lock account has no regular key/)
  }, 60_000)

  it('fails a master key that is still on, unless the run says out loud that the beta keeps it', async () => {
    const a = await fakeLedger({ masterOn: true })
    const b = await fakeLedger({ masterOn: true })
    const strict = await preflight([a, b])
    const accepted = await preflight([a, b], [], {}, { ACCEPT_MASTER_KEYS: '1' })
    a.close()
    b.close()
    expect(strict.out).toMatch(/FAIL lock account's master key is disabled/)
    expect(strict.out).toMatch(/FAIL funding account's master key is disabled/)
    expect(accepted.out).toMatch(/WARN lock account's master key is disabled: ACCEPT_MASTER_KEYS=1: the master key stays on as the recovery path/)
    expect(accepted.out).not.toMatch(/FAIL lock account's master key is disabled/)
  }, 60_000)

  it('fails without --node, because then nothing is compared with the operators', async () => {
    const a = await fakeLedger()
    const b = await fakeLedger()
    const r = await preflight([a, b])
    a.close()
    b.close()
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/FAIL a node was given to compare against \(--node\)/)
    expect(r.out).toMatch(/FAIL lock SignerList compared with the operators/)
  }, 60_000)

  it('says a planned EVM side is not on yet, and how to turn it on', async () => {
    const a = await fakeLedger()
    const b = await fakeLedger()
    const plan = { rpc: ['https://rpc.xrplevm.org'], chainId: 1440000, windowBlocks: 10, confirmations: 2, maxEventsPerView: 50, pollMs: 8000, gasLimit: 1500000, relayTimeoutMs: 180000 }
    const planned = await preflight([a, b], [], { evmPlan: plan })
    const none = await preflight([a, b])
    a.close()
    b.close()
    expect(planned.out).toMatch(/EVM side configured: planned in the genesis and not on yet.*admin\.ts evm MINTER FROM/)
    expect(planned.out).not.toMatch(/FAIL the config is one a node will run/)
    expect(none.out).toMatch(/EVM side configured: the genesis has none \(first boot, XRPL only\)/)
  }, 60_000)

  it('fails when the servers it reads from disagree about the same ledger, or are on another network', async () => {
    const a = await fakeLedger({ hash: 'AAAA' })
    const b = await fakeLedger({ hash: 'BBBB' })
    const disagree = await preflight([a, b])
    const c = await fakeLedger({ networkId: 2 })
    const wrongNet = await preflight([c, await fakeLedger()])
    for (const s of [a, b, c]) s.close()
    expect(disagree.out).toMatch(/FAIL every XRP Ledger server holds the same ledger 996/)
    expect(wrongNet.out).toMatch(/FAIL XRP Ledger server 127\.0\.0\.1:\d+ is on the main network/)
  }, 60_000)
})
