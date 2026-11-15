import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accountXrp, checkWebhook, defaultEvmRpc, deliver, loadStateFile, makeCollector, parseNodes, runPass, saveStateFile, scrub, weiToDecimal, type DeliverIO, type PassDeps } from '../scripts/watchdog'
import { DEFAULT_CONFIG, emptyState, packMessages, type ClusterReads, type Message, type NodeReading, type Snapshot, type WatchState } from '../scripts/watchdog-rules'
import { PKG, cleanupTmp, run, tmpDir } from './ops-helpers'

afterAll(cleanupTmp)

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

describe('parseNodes', () => {
  it('takes wss URLs and host:port, numbers them in order and keeps only public bits', () => {
    const n = parseNodes('wss://bridge-main.blumefi.com:8443, bridge-main.blumefi.com:8444 ,wss://other.example:9000/')
    expect(n.map((x) => x.url)).toEqual(['wss://bridge-main.blumefi.com:8443', 'wss://bridge-main.blumefi.com:8444', 'wss://other.example:9000'])
    expect(n.map((x) => x.index)).toEqual([1, 2, 3])
    expect(n[0].label).toBe('node 1 (bridge-main.blumefi.com:8443)')
  })
  it('works for any number of nodes', () => {
    expect(parseNodes(Array.from({ length: 7 }, (_, i) => `h.example:${8443 + i}`).join(','))).toHaveLength(7)
    expect(parseNodes('h.example:8443')).toHaveLength(1)
  })
  it('refuses what is not a front door', () => {
    expect(() => parseNodes('')).toThrow(/WATCHDOG_NODES is empty/)
    expect(() => parseNodes(undefined)).toThrow(/empty/)
    expect(() => parseNodes('ws://h.example:8443')).toThrow(/must be wss/)
    expect(() => parseNodes('https://h.example:8443')).toThrow(/must be wss/)
    expect(() => parseNodes('h.example')).toThrow(/no port/)
    expect(() => parseNodes('wss://user:pw@h.example:8443')).toThrow(/credentials/)
    expect(() => parseNodes('h.example:8443,wss://h.example:8443')).toThrow(/twice/)
    expect(() => parseNodes('wss://')).toThrow(/not a host:port/)
  })
})

describe('small pure helpers', () => {
  it('scrub removes secrets and any discord webhook it finds', () => {
    const hook = 'https://discord.com/api/webhooks/123/SECRETTOKEN'
    expect(scrub(`failed to reach ${hook} twice`, [hook])).toBe('failed to reach <hidden> twice')
    expect(scrub('https://discordapp.com/api/webhooks/9/ABC and more', [])).toBe('<hidden webhook> and more')
    expect(scrub('nothing here', [undefined, ''])).toBe('nothing here')
  })
  it('accountXrp subtracts the reserve for the base and every owned object', () => {
    expect(accountXrp('rX', '25000000', 20, 1, 0.2)).toEqual({ account: 'rX', balanceXrp: 25, reserveXrp: 5, freeXrp: 20 })
    expect(accountXrp('rX', '1000000', 0, 1, 0.2).freeXrp).toBe(0)
    expect(accountXrp('rX', '500000', 0, 1, 0.2).freeXrp).toBeCloseTo(-0.5)
  })
  it('weiToDecimal reads a hex quantity in 18 decimals', () => {
    expect(weiToDecimal('0xde0b6b3a7640000')).toBe('1')
    expect(weiToDecimal('0x16345785d8a0000')).toBe('0.1')
    expect(weiToDecimal('0x0')).toBe('0')
  })
  it('knows the public EVM RPCs by chain id, and nothing else', () => {
    expect(defaultEvmRpc(1440000)).toEqual(['https://rpc.xrplevm.org'])
    expect(defaultEvmRpc(1449000)).toEqual(['https://rpc.testnet.xrplevm.org'])
    expect(defaultEvmRpc(1)).toEqual([])
    expect(defaultEvmRpc(null)).toEqual([])
  })
  it('a webhook must be an https URL', () => {
    expect(checkWebhook(undefined)).toBeUndefined()
    expect(checkWebhook('  ')).toBeUndefined()
    expect(checkWebhook('https://discord.com/api/webhooks/1/x')).toBe('https://discord.com/api/webhooks/1/x')
    expect(() => checkWebhook('http://discord.com/api/webhooks/1/x')).toThrow(/https/)
    expect(() => checkWebhook('not a url')).toThrow(/not a URL/)
  })
})

describe('deliver', () => {
  const msg = (key: string): Message => ({ key, kind: 'alert', severity: 'warn', title: `Title ${key}`, lines: ['detail'] })
  const hook = 'https://discord.com/api/webhooks/42/TOPSECRET'
  function io(responses: (Response | Error)[]) {
    const calls: { url: string; body: any }[] = []
    const logs: string[] = []
    const printed: string[] = []
    const sleeps: number[] = []
    const queue = [...responses]
    const impl: DeliverIO = {
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) })
        const next = queue.shift() ?? new Response(null, { status: 204 })
        if (next instanceof Error) throw next
        return next
      }) as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
      print: (t) => printed.push(t),
      log: (l) => logs.push(l),
    }
    return { impl, calls, logs, printed, sleeps }
  }

  it('prints when there is no webhook, and counts everything delivered', async () => {
    const t = io([])
    const r = await deliver(packMessages([msg('a'), msg('b')]), undefined, t.impl)
    expect(r.failed).toEqual([])
    expect(r.delivered.map((m) => m.key)).toEqual(['a', 'b'])
    expect(t.printed).toHaveLength(1)
    expect(t.printed[0]).toContain('Title a')
    expect(t.calls).toEqual([])
  })

  it('posts the text with no mentions allowed', async () => {
    const t = io([new Response(null, { status: 204 })])
    const r = await deliver(packMessages([msg('a')]), hook, t.impl)
    expect(r.delivered).toHaveLength(1)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].url).toBe(hook)
    expect(t.calls[0].body.allowed_mentions).toEqual({ parse: [] })
    expect(t.calls[0].body.content).toContain('[WARN] Title a')
    expect(t.calls[0].body.content.length).toBeLessThanOrEqual(2000)
  })

  it('waits out a short rate limit once and then succeeds', async () => {
    const t = io([new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }), new Response(null, { status: 204 })])
    const r = await deliver(packMessages([msg('a')]), hook, t.impl)
    expect(r.delivered).toHaveLength(1)
    expect(t.sleeps).toEqual([1750])
    expect(t.calls).toHaveLength(2)
  })

  it('leaves a message undelivered after a long rate limit, a server error or a network failure, and never logs the URL', async () => {
    for (const bad of [new Response(JSON.stringify({ retry_after: 600 }), { status: 429 }), new Response('', { status: 500 }), new Error(`connect ECONNREFUSED ${hook}`)]) {
      const t = io([bad])
      const r = await deliver(packMessages([msg('a')]), hook, t.impl)
      expect(r.failed.map((m) => m.key)).toEqual(['a'])
      expect(r.delivered).toEqual([])
      expect(t.logs.join('\n')).not.toContain('TOPSECRET')
      expect(t.logs.join('\n')).toContain('will try again next pass')
    }
  })

  it('tracks each post separately', async () => {
    const big = (key: string): Message => ({ key, kind: 'alert', severity: 'warn', title: key, lines: ['x'.repeat(1200)] })
    const t = io([new Response(null, { status: 204 }), new Response('', { status: 500 })])
    const r = await deliver(packMessages([big('a'), big('b')], 1900), hook, t.impl)
    expect(r.delivered.map((m) => m.key)).toEqual(['a'])
    expect(r.failed.map((m) => m.key)).toEqual(['b'])
  })
})

// ------------------------------------------------------------------ a pass, with fakes

describe('runPass', () => {
  const healthyNode = (i: number, at: number): NodeReading => ({ index: i, label: `node ${i} (h:${8442 + i})`, ok: true, lcl: 1000 + Math.round((at - T0) / 1000), status: { k: 3, n: 5, cursor: 5000, stateHash: 'h', evmCursor: null } })
  const clusterReads = (over: Partial<ClusterReads> = {}): ClusterReads => ({ from: 1, operators: { k: 3, n: 5, ready: true, lockAccount: 'rLock', fundingAccount: 'rFund', signers: [] }, tokens: [], transfers: [], actions: [], evmActions: [], unmatched: [], ...over })
  const snapAt = (at: number, reads: ClusterReads | null = clusterReads()): Snapshot => ({ at, nodes: [1, 2, 3, 4, 5].map((i) => healthyNode(i, at)), reads, chains: { xrplHead: 5003, evmHead: null }, accounts: null, relayers: null, pools: {}, supply: null, blind: [] })

  function harness(opts: { deliverFails?: boolean } = {}) {
    let stored: WatchState = emptyState()
    let clock = T0
    let reads: ClusterReads | null = clusterReads()
    const sent: string[] = []
    const logs: string[] = []
    let saves = 0
    let beats = 0
    let failNext = opts.deliverFails ?? false
    const deps: PassDeps = {
      collect: async () => snapAt(clock, reads),
      load: () => structuredClone(stored),
      save: (s) => {
        saves++
        stored = structuredClone(s)
      },
      deliver: async (posts) => {
        if (failNext) return { delivered: [], failed: posts.flatMap((p) => p.messages) }
        sent.push(...posts.map((p) => p.text))
        return { delivered: posts.flatMap((p) => p.messages), failed: [] }
      },
      now: () => clock,
      log: (l) => logs.push(l),
      heartbeat: async () => void beats++,
    }
    return {
      deps,
      sent,
      logs,
      get saves() {
        return saves
      },
      get beats() {
        return beats
      },
      get state() {
        return stored
      },
      at: (ms: number) => void (clock = T0 + ms),
      setReads: (r: ClusterReads | null) => void (reads = r),
      failDelivery: (v: boolean) => void (failNext = v),
    }
  }
  const held = { id: 'tr-1', dir: 'out', sym: 'PETAL', amount: 5, held: { result: 'tecNO_DST', attempts: 1 } }

  it('stays quiet when all is well, writes its state, and pings the heartbeat', async () => {
    const h = harness()
    const r = await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    expect(r).toEqual({ findings: 0, sent: 0, failed: 0, active: 0 })
    expect(h.sent).toEqual([])
    expect(h.saves).toBe(1)
    expect(h.beats).toBe(1)
    expect(h.logs[0]).toMatch(/nodes 5\/5 lcl 1000 xrpl lag 3 findings 0 active 0 sent 0 failed 0/)
  })

  it('raises a held transfer once, stays quiet inside the cooldown, reminds after it and announces the end', async () => {
    const h = harness()
    await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    h.setReads(clusterReads({ transfers: [held] }))
    h.at(MIN)
    await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatch(/^\[WARN\] 1 transfer\(s\) held/)
    h.at(10 * MIN)
    await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    expect(h.sent).toHaveLength(1)
    h.at(62 * MIN)
    await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]).toMatch(/STILL FIRING/)
    h.setReads(clusterReads())
    h.at(70 * MIN)
    await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    expect(h.sent).toHaveLength(3)
    expect(h.sent[2]).toMatch(/^\[RECOVERED\] 1 transfer\(s\) held/)
    expect(Object.keys(h.state.active)).toEqual([])
  })

  it('a message that did not go out is raised again, and the heartbeat is withheld', async () => {
    const h = harness()
    await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    const beatsBefore = h.beats
    h.setReads(clusterReads({ transfers: [held] }))
    h.failDelivery(true)
    h.at(MIN)
    const bad = await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    expect(bad.failed).toBe(1)
    expect(h.state.active).toEqual({})
    expect(h.beats).toBe(beatsBefore)
    h.failDelivery(false)
    h.at(2 * MIN)
    await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    expect(h.sent).toHaveLength(1)
    expect(Object.keys(h.state.active)).toEqual(['transfers-held'])
  })

  it('does not announce a new token twice, and does not forget one it could not announce', async () => {
    const h = harness()
    await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    h.setReads(clusterReads({ tokens: [{ sym: 'MOO', name: 'Moo', issuer: 'rIssuer' }] }))
    h.failDelivery(true)
    h.at(MIN)
    await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    expect(h.state.seen.tokens).not.toContain('MOO')
    h.failDelivery(false)
    h.at(2 * MIN)
    await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    expect(h.sent).toHaveLength(1)
    expect(h.state.seen.tokens).toContain('MOO')
    h.at(3 * MIN)
    await runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })
    expect(h.sent).toHaveLength(1)
  })

  it('--dry-run delivers through the dry path, keeps no state and pings nothing', async () => {
    const h = harness()
    h.setReads(clusterReads({ transfers: [held] }))
    const r = await runPass(h.deps, DEFAULT_CONFIG, { dryRun: true })
    expect(r.findings).toBe(1)
    expect(h.saves).toBe(0)
    expect(h.beats).toBe(0)
    expect(h.state.active).toEqual({})
    expect(h.logs[0]).toMatch(/^\[dry-run\] nodes 5\/5/)
  })

  it('a pass that throws leaves the state alone', async () => {
    const h = harness()
    h.deps.collect = async () => {
      throw new Error('rpc exploded')
    }
    await expect(runPass(h.deps, DEFAULT_CONFIG, { dryRun: false })).rejects.toThrow(/rpc exploded/)
    expect(h.saves).toBe(0)
  })
})

describe('the state file', () => {
  it('round-trips, is private, and a damaged file starts fresh with a note', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'sub', 'state.json')
    const s = emptyState()
    s.seen.tokens = ['A']
    saveStateFile(file, s)
    expect(loadStateFile(file, () => {})).toEqual(s)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    const logs: string[] = []
    fs.writeFileSync(file, '{not json')
    expect(loadStateFile(file, (l) => logs.push(l))).toEqual(emptyState())
    expect(logs[0]).toMatch(/not valid JSON; starting fresh/)
    expect(loadStateFile(path.join(dir, 'missing.json'), () => {})).toEqual(emptyState())
  })
})

// ------------------------------------------------------------------ the collector, against fake RPC servers

describe('makeCollector against fake chains', () => {
  let xrpl: http.Server
  let evm: http.Server
  let xrplUrl = ''
  let evmUrl = ''
  const calls = { xrpl: [] as string[], evm: [] as string[] }
  // what the fake chains say, changed per test
  const world = {
    lockOwned: 20,
    accountMissing: false,
    supplyWei: [1000n * 10n ** 18n],
    supplyCalls: 0,
    lockHolding: '1000',
    evmDown: false,
    pool: { xrp: '50000000000', token: '2000000' } as { xrp: string; token: string } | null,
    balances: { '0xa1': 3n * 10n ** 18n, '0xb2': 5n * 10n ** 17n } as Record<string, bigint>,
  }
  const reset = () => {
    world.lockOwned = 20
    world.accountMissing = false
    world.supplyWei = [1000n * 10n ** 18n]
    world.supplyCalls = 0
    world.lockHolding = '1000'
    world.evmDown = false
    world.pool = { xrp: '50000000000', token: '2000000' }
    calls.xrpl.length = 0
    calls.evm.length = 0
  }

  function serve(handler: (body: any) => unknown | { __status: number }): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const out = handler(JSON.parse(raw))
        if (out && typeof out === 'object' && '__status' in (out as object)) {
          res.writeHead((out as { __status: number }).__status)
          res.end('down')
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      })
    })
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
  }

  beforeAll(async () => {
    xrpl = await serve((body) => {
      const method = body.method as string
      const p = body.params[0]
      calls.xrpl.push(method)
      if (method === 'server_info') return { result: { status: 'success', info: { validated_ledger: { seq: 5003, reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } } }
      if (method === 'account_info') {
        if (world.accountMissing || (p.account !== 'rLock' && p.account !== 'rFund')) return { result: { status: 'error', error: 'actNotFound' } }
        return { result: { status: 'success', account_data: { Balance: p.account === 'rLock' ? '25000000' : '8000000', OwnerCount: p.account === 'rLock' ? world.lockOwned : 1 } } }
      }
      if (method === 'amm_info') return world.pool ? { result: { status: 'success', amm: { amount: world.pool.xrp, amount2: { currency: p.asset2.currency, issuer: p.asset2.issuer, value: world.pool.token } } } } : { result: { status: 'error', error: 'actNotFound' } }
      if (method === 'account_lines') return { result: { status: 'success', lines: [{ account: p.peer, currency: 'PETAL', balance: world.lockHolding }, { account: p.peer, currency: 'OTHER', balance: '5' }] } }
      return { result: { status: 'error', error: 'unknownCmd' } }
    })
    evm = await serve((body) => {
      calls.evm.push(body.method)
      if (world.evmDown) return { __status: 503 }
      if (body.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: 1, result: '0x3e9' }
      if (body.method === 'eth_getBalance') return { jsonrpc: '2.0', id: 1, result: `0x${(world.balances[body.params[0]] ?? 0n).toString(16)}` }
      if (body.method === 'eth_call') {
        const supply = world.supplyWei[Math.min(world.supplyCalls, world.supplyWei.length - 1)]
        world.supplyCalls++
        return { jsonrpc: '2.0', id: 1, result: `0x${supply.toString(16)}` }
      }
      return { jsonrpc: '2.0', id: 1, error: { message: 'nope' } }
    })
    xrplUrl = `http://127.0.0.1:${(xrpl.address() as AddressInfo).port}`
    evmUrl = `http://127.0.0.1:${(evm.address() as AddressInfo).port}`
  })
  afterAll(() => {
    xrpl.close()
    evm.close()
  })

  const nodes = parseNodes('h.example:8443,h.example:8444,h.example:8445')
  const okNode = (spec: { index: number; label: string }): NodeReading => ({ index: spec.index, label: spec.label, ok: true, lcl: 100, status: { k: 2, n: 3, cursor: 5000, evmCursor: 900, evm: { chainId: 1449000 } } })
  const reads = (over: Partial<ClusterReads> = {}): ClusterReads => ({
    from: 1,
    operators: { k: 2, n: 3, ready: true, lockAccount: 'rLock', fundingAccount: 'rFund', evmChainId: 1449000, signers: [{ node: 'ed01', xrplAddress: 'rN1', evmAddress: '0xa1' }, { node: 'ed02', xrplAddress: 'rN2', evmAddress: '0xb2' }] },
    tokens: [{ sym: 'PETAL', name: 'Petal', issuer: 'rIssuer', currency: 'PETAL', status: 'listed', evmAddress: '0xtoken1' }],
    transfers: [],
    actions: [],
    evmActions: [],
    unmatched: [],
    ...over,
  })
  function collector(over: { reads?: ClusterReads | null; nodeList?: NodeReading[]; sleeps?: number[]; read?: (spec: { index: number }) => Promise<ClusterReads> } = {}) {
    const sleeps = over.sleeps ?? []
    const asked: number[] = []
    return {
      asked,
      sleeps,
      collect: makeCollector({
        nodes,
        networkName: 'devnet',
        xrplRpc: [xrplUrl],
        evmRpcOverride: [evmUrl],
        cfg: DEFAULT_CONFIG,
        secrets: [],
        hp: {
          readNode: async (spec) => over.nodeList?.[spec.index - 1] ?? okNode(spec),
          readCluster: async (spec) => {
            asked.push(spec.index)
            return over.read ? over.read(spec) : (over.reads ?? reads())
          },
        },
        sleep: async (ms) => void sleeps.push(ms),
      }),
    }
  }

  it('reads the heads, the reserve-adjusted XRP, the relayers and the supply check', async () => {
    reset()
    const c = collector()
    const snap = await c.collect(emptyState(), T0)
    expect(snap.chains).toEqual({ xrplHead: 5003, evmHead: 1001 })
    // lock: 25 XRP, 20 owned objects: reserve 1 + 20 * 0.2 = 5
    expect(snap.accounts?.lock).toMatchObject({ account: 'rLock', balanceXrp: 25, reserveXrp: 5, freeXrp: 20 })
    expect(snap.accounts?.funding).toMatchObject({ balanceXrp: 8, reserveXrp: 1.2 })
    expect(snap.relayers).toEqual([{ address: '0xa1', node: 'ed01', balanceXrp: 3 }, { address: '0xb2', node: 'ed02', balanceXrp: 0.5 }])
    expect(snap.supply).toEqual([{ sym: 'PETAL', holding: '1000', supply: '1000' }])
    expect(snap.blind).toEqual([])
    expect(snap.nodes).toHaveLength(3)
    expect(snap.reads?.tokens).toHaveLength(1)
  })

  it('asks a different healthy node for the cluster reads each pass', async () => {
    reset()
    const c = collector()
    for (let i = 0; i < 4; i++) await c.collect(emptyState(), T0 + i * MIN)
    expect(new Set(c.asked).size).toBe(3)
    // and never a node that did not answer
    const c2 = collector({ nodeList: [{ index: 1, label: 'node 1', ok: false, error: 'down' }, okNode(nodes[1]), okNode(nodes[2])] })
    for (let i = 0; i < 4; i++) await c2.collect(emptyState(), T0 + i * MIN)
    expect(c2.asked).not.toContain(1)
  })

  it('a supply shortfall is read again before it is believed, and a cleared one is not reported', async () => {
    reset()
    world.supplyWei = [1500n * 10n ** 18n, 1000n * 10n ** 18n]
    const c = collector()
    const snap = await c.collect(emptyState(), T0)
    expect(snap.supply).toEqual([{ sym: 'PETAL', holding: '1000', supply: '1000' }])
    expect(c.sleeps).toContain(15_000)
    // one that persists is reported as it is
    reset()
    world.supplyWei = [1500n * 10n ** 18n]
    const persistent = await collector().collect(emptyState(), T0)
    expect(persistent.supply).toEqual([{ sym: 'PETAL', holding: '1000', supply: '1500' }])
  })

  it('does the supply check only when due, and only for the tokens already short while one is tracked', async () => {
    reset()
    const state = emptyState()
    state.lastSupplyCheckAt = T0 - 3_600_000
    const c = collector()
    expect((await c.collect(state, T0)).supply).toBeNull()
    expect(calls.evm).not.toContain('eth_call')
    const tracking = { ...state, active: { 'supply-short:PETAL': { kind: 'supply-short', severity: 'critical' as const, title: 't', since: T0, lastSentAt: T0, fingerprint: '' } } }
    const two = collector({ reads: reads({ tokens: [{ sym: 'PETAL', issuer: 'rIssuer', currency: 'PETAL', status: 'listed', evmAddress: '0xtoken1' }, { sym: 'MOO', issuer: 'rIssuer', currency: 'MOO', status: 'listed', evmAddress: '0xtoken2' }] }) })
    const snap = await two.collect(tracking, T0)
    expect(snap.supply?.map((r) => r.sym)).toEqual(['PETAL'])
  })

  it('a token with no trust line holds nothing', async () => {
    reset()
    const snap = await collector({ reads: reads({ tokens: [{ sym: 'MOO', issuer: 'rIssuer', currency: 'MOO', status: 'listed', evmAddress: '0xtoken2' }] }) }).collect(emptyState(), T0)
    expect(snap.supply).toEqual([{ sym: 'MOO', holding: '0', supply: '1000' }])
  })

  it('says it is blind, and where, when an account is not on the network it was pointed at', async () => {
    reset()
    world.accountMissing = true
    const snap = await collector().collect(emptyState(), T0)
    expect(snap.accounts).toEqual({ lock: null, funding: null })
    expect(snap.blind.join('\n')).toMatch(/lock account rLock does not exist on XRPL Devnet: is XRPL_NETWORK=devnet right\?/)
  })

  it('an EVM RPC that is down leaves the head and the relayers unread and says so', async () => {
    reset()
    world.evmDown = true
    const snap = await collector().collect(emptyState(), T0)
    expect(snap.chains.evmHead).toBeNull()
    expect(snap.relayers).toBeNull()
    expect(snap.supply?.every((r) => r.error)).toBe(true)
    expect(snap.blind.join('\n')).toMatch(/XRPL EVM head/)
  })

  it('looks up a pool only for tokens it has not seen, and only after the first baseline', async () => {
    reset()
    const withMoo = reads({ tokens: [{ sym: 'PETAL', issuer: 'rIssuer', currency: 'PETAL', status: 'listed' }, { sym: 'MOO', issuer: 'rIssuer', currency: 'MOO', status: 'listed' }] })
    const first = await collector({ reads: withMoo }).collect(emptyState(), T0)
    expect(first.pools).toEqual({})
    const seen = emptyState()
    seen.baselined.tokens = true
    seen.seen.tokens = ['PETAL']
    const second = await collector({ reads: withMoo }).collect(seen, T0)
    expect(Object.keys(second.pools)).toEqual(['MOO'])
    expect(second.pools.MOO).toEqual({ xrp: '50000', tokens: '2000000' })
    world.pool = null
    const none = await collector({ reads: withMoo }).collect(seen, T0)
    expect(none.pools.MOO).toBeNull()
  })

  it('a cluster with no EVM side reads no EVM chain', async () => {
    reset()
    const noEvm = reads({ operators: { k: 2, n: 3, ready: true, lockAccount: 'rLock', fundingAccount: 'rFund', evmChainId: null, signers: [] }, tokens: [] })
    const nodeList = [1, 2, 3].map((i) => ({ ...okNode(nodes[i - 1]), status: { k: 2, n: 3, cursor: 5000, evmCursor: null, evm: null } }))
    const snap = await collector({ reads: noEvm, nodeList }).collect(emptyState(), T0)
    expect(snap.chains.evmHead).toBeNull()
    expect(calls.evm).toEqual([])
  })

  it('no healthy node means no cluster reads, and the XRP Ledger is still read', async () => {
    reset()
    const down = [1, 2, 3].map((i): NodeReading => ({ index: i, label: `node ${i}`, ok: false, error: 'connect timeout' }))
    const snap = await collector({ nodeList: down }).collect(emptyState(), T0)
    expect(snap.reads).toBeNull()
    expect(snap.chains.xrplHead).toBe(5003)
    expect(snap.accounts).toBeNull()
  })
})

// ------------------------------------------------------------------ the program

describe('watchdog.ts as a program', () => {
  const SCRIPT = path.join(PKG, 'scripts/watchdog.ts')
  const sh = (args: string[], env: Record<string, string | undefined> = {}) => run('npx', ['--no-install', 'tsx', SCRIPT, ...args], { env: { WATCHDOG_NODES: undefined, WATCHDOG_WEBHOOK: undefined, XRPL_NETWORK: undefined, ...env } })

  it('--help explains itself', () => {
    const r = sh(['--help'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/Runs anywhere off the node boxes/)
    expect(r.out).toMatch(/--dry-run/)
  })

  it('refuses a missing or wrong node list, an unknown flag and a bad threshold', () => {
    expect(sh([]).status).toBe(1)
    expect(sh([]).out).toMatch(/WATCHDOG_NODES is empty/)
    expect(sh(['--once'], { WATCHDOG_NODES: 'ws://h:1' }).out).toMatch(/must be wss/)
    expect(sh(['--frobnicate'], { WATCHDOG_NODES: 'h.example:8443' }).out).toMatch(/unknown argument/)
    expect(sh(['--once'], { WATCHDOG_NODES: 'h.example:8443', WATCHDOG_XRPL_LAG_LEDGERS: 'lots' }).out).toMatch(/WATCHDOG_XRPL_LAG_LEDGERS must be a positive number/)
    expect(sh(['--once'], { WATCHDOG_NODES: 'h.example:8443', WATCHDOG_WEBHOOK: 'http://x.example/hook' }).out).toMatch(/must be an https URL/)
  })

  it('--print-config shows the settings and never the webhook', () => {
    const hook = 'https://discord.com/api/webhooks/777/NEVERPRINTTHIS'
    const r = sh(['--print-config'], { WATCHDOG_NODES: 'a.example:8443,a.example:8444,a.example:8445,a.example:8446,a.example:8447', WATCHDOG_WEBHOOK: hook, XRPL_NETWORK: 'mainnet' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('nodes (5)')
    expect(r.out).toContain('network mainnet')
    expect(r.out).toContain('webhook set')
    expect(r.out).not.toContain('NEVERPRINTTHIS')
    expect(r.out).toContain('"xrplLagLedgers": 100')
  })

  it('--test-alert prints to stdout without a webhook', () => {
    const r = sh(['--test-alert'], { WATCHDOG_NODES: 'a.example:8443' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/\[INFO\] Watchdog test alert from/)
    expect(r.out).toMatch(/WATCHDOG_WEBHOOK is unset/)
  })

  it('--test-alert fails loudly, and without the URL, when the webhook is unreachable', () => {
    const hook = 'https://127.0.0.1:9/api/webhooks/1/URLSECRETXYZ'
    const r = sh(['--test-alert'], { WATCHDOG_NODES: 'a.example:8443', WATCHDOG_WEBHOOK: hook })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/NOT delivered/)
    expect(r.out).not.toContain('URLSECRETXYZ')
  })

  it('--once --dry-run against nothing at all reads what it can, prints a summary and keeps no state', () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, 'state.json')
    const r = sh(['--once', '--dry-run'], { WATCHDOG_NODES: '127.0.0.1:1,127.0.0.1:2', WATCHDOG_XRPL_RPC: 'http://127.0.0.1:1', WATCHDOG_STATE: stateFile, WATCHDOG_NODE_TIMEOUT_SECONDS: '2', WATCHDOG_RPC_TIMEOUT_SECONDS: '2' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/\[dry-run\] nodes 0\/2 lcl - xrpl lag \? findings 0/)
    expect(fs.existsSync(stateFile)).toBe(false)
  }, 30_000)
})
