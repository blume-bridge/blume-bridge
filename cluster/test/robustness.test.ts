import { describe, expect, it } from 'vitest'
import { isRequest, own } from '../src/canon'
import { validateIntent } from '../src/machine'
import { startCollector } from '../src/vote'
import { ALICE, EVM, NOW, baseState } from './helpers'

/**
 * Inputs and peer messages are untrusted. Each of these once threw out of the consensus round, which on a real
 * cluster ends the contract process on every node at the same input (pre-mainnet review, 2026-10-17, root causes 1 and 2).
 */

describe('requests', () => {
  it('only a plain JSON object is a request', () => {
    for (const bad of [null, 5, 'x', true, [], [{}]]) expect(isRequest(bad)).toBe(false)
    expect(isRequest({})).toBe(true)
    expect(isRequest({ type: 'ping' })).toBe(true)
  })

  it('a record lookup never returns something off Object.prototype', () => {
    const rec = { abc: 1 } as Record<string, number>
    expect(own(rec, 'abc')).toBe(1)
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) expect(own(rec, key)).toBeUndefined()
  })
})

describe('intent amounts', () => {
  const ask = (amount: unknown) => validateIntent(baseState(), { dir: 'in', sym: 'XRP', amount, from: ALICE, to: EVM })

  it('turns away an amount that parses but cannot be formatted back, instead of throwing', () => {
    for (const amount of ['1e64', '1e90', '9'.repeat(41), '1e41']) {
      const r = ask(amount)
      expect(r.ok, amount).toBe(false)
    }
  })

  it('still accepts ordinary and large-but-carriable amounts', () => {
    for (const amount of ['1', '0.000001', ' 12.5 ', '123456789.123456789', '1e40']) expect(ask(amount).ok, amount).toBe(true)
  })

  it('refuses zero, negative and non-decimal amounts with a message', () => {
    for (const amount of ['0', '-1', '0.0', 'abc', '', undefined, null, {}, []]) {
      const r = ask(amount)
      expect(r.ok, String(amount)).toBe(false)
    }
  })
})

describe('the vote collector', () => {
  const fakeCtx = () => {
    let cb: ((node: { publicKey: string }, msg: Buffer) => void) | undefined
    const ctx = {
      publicKey: 'me',
      unl: {
        onMessage: (fn: typeof cb) => {
          cb = fn
        },
        send: async () => undefined,
        count: () => 4,
      },
    }
    return { ctx, hear: (node: string, body: unknown) => cb!({ publicKey: node }, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))) }
  }

  it('survives every kind of garbage a peer can send, and still counts honest peers', async () => {
    const { ctx, hear } = fakeCtx()
    const c = startCollector(ctx, 7)
    const garbage: unknown[] = [
      'null',
      '5',
      '"text"',
      '[]',
      '{',
      { t: 'round', r: 7, views: 5 },
      { t: 'round', r: 7, views: { a: 1 } },
      { t: 'round', r: 7, views: [null, 5, 'x', { view: null }, { view: 5, hash: 'x' }, { src: 'xrpl', hash: 'x', view: [] }] },
      { t: 'round', r: 7, keys: 5, sigs: 5 },
      { t: 'round', r: 7, sigs: [null, 5, { a: 1 }, { a: 'x', s: null }], att: { length: 3 } },
      { t: 'round', r: 7, att: [null, 5, { a: 'x' }] },
      { t: 'round', r: 7, views: Array.from({ length: 5000 }, () => null) },
    ]
    garbage.forEach((g, i) => expect(() => hear(`peer${i}`, g), JSON.stringify(g)?.slice(0, 60)).not.toThrow())
    const out = await c.collect(0, 50)
    expect(out.votes).toEqual([])
    expect(out.sigs).toEqual([])
    expect(out.att).toEqual([])
  })

  it('caps how long a list from a peer may be', async () => {
    const { ctx, hear } = fakeCtx()
    const c = startCollector(ctx, 3)
    const sig = { a: 'act', s: { Signer: { Account: 'rX' } } }
    hear('peer', { t: 'round', r: 3, sigs: Array.from({ length: 5000 }, () => sig) })
    const out = await c.collect(0, 50)
    expect(out.sigs.length).toBe(256)
  })
})

describe('attestation signatures', () => {
  it('accepts a canonical signature and refuses its malleated twin', async () => {
    const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')
    const { isCanonicalSignature, ingestAttestations, myAttestations } = await import('../src/attest')
    const { evmState } = await import('./helpers')
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const s = evmState()
    s.operators = { me: { node: 'me', xrplAddress: 'rMe', xrplPublicKey: 'EDme', evmAddress: account.address } }
    s.evmActions['act1'] = {
      id: 'act1',
      kind: 'mint',
      status: 'pending',
      data: { tokenId: `0x${'11'.repeat(32)}`, to: `0x${'22'.repeat(20)}`, amount: '1000', srcTx: `0x${'33'.repeat(32)}` },
      reason: { kind: 'mint', transferId: 't1' },
      relayer: 0,
      relayAt: 0,
      attempts: 0,
      createdAt: 0,
      updatedAt: 0,
    }
    const keys = { evm: { address: account.address, privateKey: pk }, xrpl: { address: 'rMe', publicKey: 'EDme', privateKey: 'x' } } as never
    const [signed] = await myAttestations(s, keys, {})
    expect(isCanonicalSignature(signed.s)).toBe(true)

    // The twin: same r, s' = n - s, v flipped. The curve verifies it for the same signer; the minter's ECDSA.recover reverts it.
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const r = signed.s.slice(2, 66)
    const sBig = BigInt(`0x${signed.s.slice(66, 130)}`)
    const v = parseInt(signed.s.slice(130, 132), 16)
    const twin = `0x${r}${(N - sBig).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as `0x${string}`
    expect(isCanonicalSignature(twin)).toBe(false)

    const poisoned = {}
    expect(await ingestAttestations(s, poisoned, [{ node: 'me', att: { a: 'act1', e: account.address, s: twin } }])).toBe(0)
    expect(poisoned).toEqual({ act1: { sigs: {} } })

    const clean = {}
    expect(await ingestAttestations(s, clean, [{ node: 'me', att: signed }])).toBe(1)
  })

  it('rejects the wrong length, the wrong v, and a zero or oversized s', async () => {
    const { isCanonicalSignature } = await import('../src/attest')
    const r = 'ab'.repeat(32)
    const ok = `0x${r}${'01'.padStart(64, '0')}1b`
    expect(isCanonicalSignature(ok)).toBe(true)
    expect(isCanonicalSignature(`0x${r}${'01'.padStart(64, '0')}00`)).toBe(false)
    expect(isCanonicalSignature(`0x${r}${'01'.padStart(64, '0')}1d`)).toBe(false)
    expect(isCanonicalSignature(`0x${r}${'00'.repeat(32)}1b`)).toBe(false)
    expect(isCanonicalSignature(`0x${r}${'ff'.repeat(32)}1b`)).toBe(false)
    expect(isCanonicalSignature(ok.slice(0, -2))).toBe(false)
    expect(isCanonicalSignature(null)).toBe(false)
    expect(isCanonicalSignature(5)).toBe(false)
  })

  it('names the signature failures the minter can raise, including the ones its ABI does not carry', async () => {
    const { classifyRelayError } = await import('../src/attest')
    expect(classifyRelayError(new Error('reverted with custom error 0xd78bce0c'), 'mint')).toBe('bad-signature')
    expect(classifyRelayError(new Error('ECDSAInvalidSignatureS'), 'list')).toBe('bad-signature')
  })
})

describe('which server a node asks first', () => {
  it('differs from node to node, is stable for one node, and spreads a cluster over the servers', async () => {
    const { configureNode, rotated } = await import('../src/feed/node')
    const servers = ['https://a.example', 'https://b.example', 'https://c.example']
    const firsts = new Set<string>()
    for (let i = 0; i < 20; i++) {
      configureNode(`ed${i}`.padEnd(66, '0'), { xrpl: true, evm: true })
      const order = rotated(servers, 'xrpl')
      expect([...order].sort()).toEqual([...servers].sort())
      expect(rotated(servers, 'xrpl')).toEqual(order)
      firsts.add(order[0])
    }
    // Twenty nodes do not all start at one server: no single liar is believed by all of them.
    expect(firsts.size).toBe(3)
  })

  it('does nothing when the operator\'s own servers lead the list, or there is only one', async () => {
    const { configureNode, rotated } = await import('../src/feed/node')
    configureNode('edabc', { xrpl: false, evm: true })
    expect(rotated(['x', 'y', 'z'], 'xrpl')).toEqual(['x', 'y', 'z'])
    expect(rotated(['x'], 'evm')).toEqual(['x'])
    configureNode('', { xrpl: true, evm: true })
    expect(rotated(['x', 'y', 'z'], 'xrpl')).toEqual(['x', 'y', 'z'])
  })
})

describe('a burn that exceeds what is locked', () => {
  it('releases nothing, mints nothing back, and stops the token taking deposits', async () => {
    const { applyEvmView } = await import('../src/machine')
    const { evmState, NOW, ALICE, EVM } = await import('./helpers')
    const ADDR = '0x1111111111111111111111111111111111111111'
    const s = evmState()
    s.tokens.PETAL.evmAddress = ADDR
    s.tokens.PETAL.lockedUnits = '100'
    const view = { src: 'evm' as const, from: 1000, to: 1010, listings: {}, events: [{ kind: 'burn' as const, tx: '0xb', block: 1005, logIndex: 0, token: ADDR, from: EVM, amountWei: '150000000000000000000', rAddress: ALICE, nonce: '1' }] }
    const r = applyEvmView(s, view, NOW)
    const t = Object.values(r.state.transfers).find((tr) => tr.dir === 'out')!
    expect(t.failed).toBe('unbacked')
    expect(t.held).toBeUndefined()
    expect(t.actionId).toBeUndefined()
    expect(Object.keys(r.state.actions)).toHaveLength(0)
    expect(r.state.tokens.PETAL.opPaused).toBe(true)
    expect(r.state.tokens.PETAL.lockedUnits).toBe('100')
    expect(r.applied.map((a) => a.kind)).toContain('evm.burn.unbacked')
  })

  it('still releases a burn of exactly what is locked', async () => {
    const { applyEvmView } = await import('../src/machine')
    const { evmState, NOW, ALICE, EVM } = await import('./helpers')
    const ADDR = '0x1111111111111111111111111111111111111111'
    const s = evmState()
    s.tokens.PETAL.evmAddress = ADDR
    s.tokens.PETAL.lockedUnits = '100'
    const view = { src: 'evm' as const, from: 1000, to: 1010, listings: {}, events: [{ kind: 'burn' as const, tx: '0xb', block: 1005, logIndex: 0, token: ADDR, from: EVM, amountWei: '100000000000000000000', rAddress: ALICE, nonce: '1' }] }
    const r = applyEvmView(s, view, NOW)
    const t = Object.values(r.state.transfers).find((tr) => tr.dir === 'out')!
    expect(t.failed).toBeUndefined()
    expect(t.actionId).toBeDefined()
    expect(r.state.tokens.PETAL.opPaused).toBeUndefined()
  })
})

describe('a node\'s signing keys', () => {
  const tmp = async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    return join(mkdtempSync(join(tmpdir(), 'keys-')), 'bridge-keys.json')
  }

  it('are made once when the file is absent, atomically and readable by the owner only', async () => {
    const fs = await import('node:fs')
    const { ensureKeys } = await import('../src/keys')
    const path = await tmp()
    const a = ensureKeys({ path })
    expect(a.xrpl.seed).toBeTruthy()
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(`${path}.tmp`)).toBe(false)
    expect(ensureKeys({ path })).toEqual(a)
  })

  it('are never replaced because the file would not read: empty, half-written, not keys, or unreadable', async () => {
    const fs = await import('node:fs')
    const { ensureKeys } = await import('../src/keys')
    for (const body of ['', '{"xrpl":{"seed":"sEd', '[]', '{"xrpl":{},"evm":{}}']) {
      const path = await tmp()
      fs.writeFileSync(path, body)
      expect(() => ensureKeys({ path }), JSON.stringify(body)).toThrow(/refusing to replace|not valid JSON/)
      expect(fs.readFileSync(path, 'utf8')).toBe(body) // untouched
    }
    const dir = await tmp()
    fs.mkdirSync(dir) // a directory where the file should be: EISDIR, not ENOENT
    expect(() => ensureKeys({ path: dir })).toThrow(/cannot read/)
  })

  it('are not made again for a node that is already an admitted operator', async () => {
    const { ensureKeys } = await import('../src/keys')
    const path = await tmp()
    expect(() => ensureKeys({ path, mayGenerate: false })).toThrow(/already an admitted operator/)
    expect(ensureKeys({ path, mayGenerate: true }).evm.address).toMatch(/^0x[0-9a-f]{40}$/)
  })
})

describe('the intent flood', () => {
  it('is bounded for the whole bridge, not only per key, because keys cost nothing', async () => {
    const { createIntent, DEFAULT_MAX_OPEN_INTENTS_TOTAL } = await import('../src/machine')
    const s = baseState()
    const req = { dir: 'in', sym: 'PETAL', amount: '1', from: ALICE, to: EVM }
    for (let i = 0; i < DEFAULT_MAX_OPEN_INTENTS_TOTAL; i++) {
      const key = `ed${i}`.padEnd(66, '0')
      const v = validateIntent(s, req, key)
      expect(v.ok, `intent ${i}`).toBe(true)
      if (!v.ok) return
      createIntent(s, v.intent, `id${String(i).padStart(14, '0')}`, NOW, key, true)
    }
    expect(Object.keys(s.transfers)).toHaveLength(DEFAULT_MAX_OPEN_INTENTS_TOTAL)
    const next = validateIntent(s, req, 'edfresh'.padEnd(66, '0'))
    expect(next).toMatchObject({ ok: false, error: expect.stringMatching(/lot of unfinished transfers/) })
  })

  it('creates in place only when asked, and leaves the caller\'s state alone otherwise', async () => {
    const { createIntent } = await import('../src/machine')
    const s = baseState()
    const v = validateIntent(s, { dir: 'in', sym: 'PETAL', amount: '1', from: ALICE, to: EVM }, 'edaaa'.padEnd(66, '0'))
    if (!v.ok) throw new Error(v.error)
    const copy = createIntent(s, v.intent, 'a'.repeat(16), NOW, 'edaaa'.padEnd(66, '0'))
    expect(Object.keys(s.transfers)).toHaveLength(0)
    expect(Object.keys(copy.state.transfers)).toHaveLength(1)
    const same = createIntent(s, v.intent, 'b'.repeat(16), NOW, 'edaaa'.padEnd(66, '0'), true)
    expect(same.state).toBe(s)
    expect(Object.keys(s.transfers)).toHaveLength(1)
  })

  it('is a parameter a genesis can set, and must be a whole number', async () => {
    const { configProblems } = await import('../src/state')
    const s = baseState()
    expect(configProblems({ ...s.config, params: { ...s.config.params, maxOpenIntentsTotal: 50 } })).toEqual([])
    expect(configProblems({ ...s.config, params: { ...s.config.params, maxOpenIntentsTotal: 0 } }).join()).toMatch(/maxOpenIntentsTotal/)
  })
})

describe('reads pinned to a ledger', () => {
  it('are made once and remembered, so a read that finishes late is waiting for the next round', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    process.env.BRIDGE_READS_CACHE = join(mkdtempSync(join(tmpdir(), 'reads-')), 'reads.json')
    // the cache path is read when the module loads
    const { vi } = await import('vitest')
    vi.resetModules()
    const { pinned } = await import('../src/feed/xrpl')
    let calls = 0
    const read = async () => {
      calls++
      return { sequence: 5, balanceDrops: '100' }
    }
    expect(await pinned('snap:rX@100', read)).toEqual({ sequence: 5, balanceDrops: '100' })
    expect(await pinned('snap:rX@100', read)).toEqual({ sequence: 5, balanceDrops: '100' })
    expect(calls).toBe(1)
    await pinned('snap:rX@101', read)
    expect(calls).toBe(2)
    // a failure is not remembered: it is asked again
    let tries = 0
    const flaky = async () => {
      if (tries++ === 0) throw new Error('timeout')
      return { sequence: 9, balanceDrops: '1' }
    }
    await expect(pinned('snap:rY@1', flaky)).rejects.toThrow('timeout')
    expect(await pinned('snap:rY@1', flaky)).toEqual({ sequence: 9, balanceDrops: '1' })
    delete process.env.BRIDGE_READS_CACHE
  })
})

describe('a seed token with no cap', () => {
  const UNCAPPED = (2n ** 256n - 1n).toString()
  const listed = async (patch: Record<string, unknown>) => {
    const { queueEvmWork } = await import('../src/machine')
    const { evmState, NOW } = await import('./helpers')
    const s = evmState()
    Object.assign(s.tokens.PETAL, patch)
    if (patch.capUnits === undefined) delete (s.tokens.PETAL as { capUnits?: string }).capUnits
    queueEvmWork(s, NOW)
    return { s, action: Object.values(s.evmActions).find((a) => a.kind === 'list' && a.reason.kind === 'list' && a.reason.sym === 'PETAL')! }
  }

  it('is listed on the minter with no limit, so it takes whatever is bridged', async () => {
    const { action } = await listed({ lane: 'genesis', capUnits: undefined })
    expect(action.data.dailyCap).toBe(UNCAPPED)
  })

  it('keeps a cap the genesis gave it', async () => {
    const { action } = await listed({ lane: 'genesis', capUnits: '2500' })
    expect(action.data.dailyCap).toBe('2500000000000000000000')
  })

  it('is not the default for a token listed any other way: those take the default cap (0 in production) until an operator opens them', async () => {
    const { toWei } = await import('../src/machine')
    const issuer = await listed({ lane: 'issuer', capUnits: '0' })
    expect(issuer.action.data.dailyCap).toBe(toWei(issuer.s.config.params.defaultCapUnits))
    const none = await listed({ lane: undefined, capUnits: undefined })
    expect(none.action.data.dailyCap).toBe(toWei(none.s.config.params.defaultCapUnits))
    expect(none.action.data.dailyCap).not.toBe(UNCAPPED)
    // and the production profile's default is 0: nothing mints until an operator sets a cap
    const { params } = await import('../scripts/genesis-params')
    expect(params('production', {}).defaultCapUnits).toBe('0')
  })

  it('stays uncapped on the cluster when the minter confirms it, and takes any lock', async () => {
    const { applyEvmView } = await import('../src/machine')
    const { tokenIdOf } = await import('../src/evm')
    const { evmState, NOW } = await import('./helpers')
    const { s } = await listed({ lane: 'genesis', capUnits: undefined })
    const view = { src: 'evm' as const, from: s.cursor.evm!.block, to: s.cursor.evm!.block + 3, listings: {}, events: [{ kind: 'listed' as const, tx: '0xaaa', block: s.cursor.evm!.block + 1, logIndex: 0, tokenId: tokenIdOf(s.tokens.PETAL), token: '0x1111111111111111111111111111111111111111', symbol: 'PETAL', dailyCapWei: UNCAPPED }] }
    const after = applyEvmView(s, view, NOW).state
    expect(after.tokens.PETAL.evmAddress).toBe('0x1111111111111111111111111111111111111111')
    expect(after.tokens.PETAL.capUnits).toBeUndefined()
    void evmState
  })
})
