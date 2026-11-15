import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeAbiParameters, encodeEventTopics, type PublicClient } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MINTER_ABI, tokenIdOf } from '../src/evm'
import { evmView, logsAndHead } from '../src/feed/evm'
import type { EvmConfig, State } from '../src/types'

const MINTER = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const ZERO = '0x0000000000000000000000000000000000000000'
const CFG: EvmConfig = { rpc: ['http://127.0.0.1:1'], chainId: 1449000, minter: MINTER, windowBlocks: 10, confirmations: 2, maxEventsPerView: 50, pollMs: 8000, gasLimit: 1500000, relayTimeoutMs: 180000 }

const tok = (sym: string, over: Record<string, unknown> = {}) => ({ sym, status: 'listed', currency: sym.padEnd(40, '0'), issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', ...over })
/** Only what evmView reads: the EVM config, the cursor and the tokens. */
const stateOf = (tokens: Record<string, unknown>, cfg: EvmConfig = CFG) => ({ config: { evm: cfg }, cursor: { evm: { block: 100, seen: [] } }, tokens }) as unknown as State

interface Listed {
  token: string
  cap: bigint
  nonce: bigint
}
/** A minter and a head, answering the three client calls the feed makes. Multicalls are recorded with the block they were pinned to. */
function chain(opts: { head?: number; paused?: boolean; burnFee?: bigint; listed?: Record<string, Listed>; logs?: unknown[]; failMulticall?: boolean }) {
  const multicalls: { block: bigint; fns: string[] }[] = []
  const client = {
    getBlockNumber: async () => BigInt(opts.head ?? 130),
    request: async ({ method }: { method: string }) => {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`)
      return opts.logs ?? []
    },
    multicall: async ({ contracts, blockNumber }: { contracts: { functionName: string; args?: any[] }[]; blockNumber: bigint }) => {
      if (opts.failMulticall) throw new Error('returned no data')
      multicalls.push({ block: blockNumber, fns: contracts.map((c) => c.functionName) })
      return contracts.map((c) => {
        const arg = c.args?.[0]
        switch (c.functionName) {
          case 'paused':
            return opts.paused ?? false
          case 'burnFee':
            return opts.burnFee ?? 250000000000000000n
          case 'tokens':
            return opts.listed?.[arg]?.token ?? ZERO
          case 'metaNonce':
            return opts.listed?.[arg]?.nonce ?? 0n
          case 'caps':
            return [Object.values(opts.listed ?? {}).find((l) => l.token === arg)?.cap ?? 0n, 0n, 0n]
          default:
            throw new Error(`unexpected ${c.functionName}`)
        }
      })
    },
  }
  return { client: client as unknown as PublicClient, multicalls }
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evm-view-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('evmView: what the minter holds at the window end', () => {
  it('carries paused and burnFee, read at the block the window ends on', async () => {
    const c = chain({ paused: true, burnFee: 250000000000000000n })
    const view = await evmView(stateOf({ DONE: tok('DONE', { evmAddress: ALICE }) }), 900, { client: c.client, cacheDir: dir })
    expect(view).not.toBeNull()
    expect(view!.from).toBe(100)
    expect(view!.to).toBe(110)
    expect(view!.paused).toBe(true)
    expect(view!.burnFee).toBe('250000000000000000')
    expect(view!.listings).toEqual({})
    // Nothing is waiting to be adopted, so the two switches are the only reads.
    expect(c.multicalls).toEqual([{ block: 110n, fns: ['paused', 'burnFee'] }])
  })

  it('reports an unpaused minter and a fee of zero as such, not as absent', async () => {
    const c = chain({ paused: false, burnFee: 0n })
    const view = await evmView(stateOf({}), 900, { client: c.client, cacheDir: dir })
    expect(view!.paused).toBe(false)
    expect(view!.burnFee).toBe('0')
  })

  it('reads the switches in the same multicall as the address and nonce of every listing it adopts; the caps are the second and last', async () => {
    const petal = tok('PETAL')
    const moo = tok('MOO')
    const unlisted = tok('NEW')
    const c = chain({
      listed: {
        [tokenIdOf(petal as any)]: { token: '0x00000000000000000000000000000000000000Aa', cap: 50000n * 10n ** 18n, nonce: 2n },
        [tokenIdOf(moo as any)]: { token: '0x00000000000000000000000000000000000000Bb', cap: 0n, nonce: 0n },
      },
    })
    const view = await evmView(stateOf({ PETAL: petal, MOO: moo, NEW: unlisted }), 900, { client: c.client, cacheDir: dir })
    expect(c.multicalls).toHaveLength(2)
    expect(c.multicalls[0].fns).toEqual(['paused', 'burnFee', 'tokens', 'tokens', 'tokens', 'metaNonce', 'metaNonce', 'metaNonce'])
    expect(c.multicalls[1].fns).toEqual(['caps', 'caps'])
    expect(c.multicalls.map((m) => m.block)).toEqual([110n, 110n])
    expect(Object.keys(view!.listings).sort()).toEqual([tokenIdOf(petal as any), tokenIdOf(moo as any)].sort())
    expect(view!.listings[tokenIdOf(petal as any)]).toEqual({ token: '0x00000000000000000000000000000000000000aa', dailyCapWei: (50000n * 10n ** 18n).toString(), metaNonce: '2' })
    // A cap of 0 is a real value on a v3 minter (no mints): it comes through as '0'.
    expect(view!.listings[tokenIdOf(moo as any)].dailyCapWei).toBe('0')
    expect(view!.paused).toBe(false)
  })

  it('needs no second round trip when the minter lists none of the pending tokens', async () => {
    const c = chain({})
    const view = await evmView(stateOf({ NEW: tok('NEW') }), 900, { client: c.client, cacheDir: dir })
    expect(c.multicalls).toHaveLength(1)
    expect(view!.listings).toEqual({})
  })

  it('pins the reads to the block a cut window ends on, not the block it would have ended on', async () => {
    const id = tokenIdOf(tok('MOO') as any)
    const log = (block: number, i: number) => ({
      address: MINTER,
      blockNumber: `0x${block.toString(16)}`,
      transactionHash: `0x${i.toString(16).padStart(64, '0')}`,
      logIndex: `0x${i.toString(16)}`,
      topics: encodeEventTopics({ abi: MINTER_ABI, eventName: 'Minted', args: { tokenId: id, to: ALICE, srcTx: `0x${i.toString(16).padStart(64, '0')}` } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [10n ** 18n]),
    })
    const c = chain({ logs: [log(102, 1), log(102, 2), log(104, 3), log(106, 4), log(108, 5)] })
    const view = await evmView(stateOf({}, { ...CFG, maxEventsPerView: 2 }), 900, { client: c.client, cacheDir: dir })
    expect(view!.to).toBe(102)
    expect(view!.events).toHaveLength(2)
    expect(c.multicalls[0].block).toBe(102n)
  })

  it('proposes nothing when the minter cannot answer, rather than a view without the fields', async () => {
    const c = chain({ failMulticall: true })
    await expect(evmView(stateOf({}), 900, { client: c.client, cacheDir: dir })).rejects.toThrow(/is it a v3 minter/)
  })

  it('proposes nothing before the window is a few blocks behind the head', async () => {
    const c = chain({ head: 111 })
    expect(await evmView(stateOf({}), 900, { client: c.client, cacheDir: dir })).toBeNull()
    expect(c.multicalls).toEqual([])
  })

  it('catches up a whole span per round when the cursor is a span or more behind, pinned to that window end', async () => {
    const c = chain({ head: 100 + 500 + 2 + 50 })
    const view = await evmView(stateOf({}), 900, { client: c.client, cacheDir: dir })
    expect(view!.from).toBe(100)
    expect(view!.to).toBe(600)
    expect(c.multicalls).toEqual([{ block: 600n, fns: ['paused', 'burnFee'] }])
  })

  it('keeps the normal window once the cursor is less than a span behind', async () => {
    const c = chain({ head: 100 + 499 + 2 })
    const view = await evmView(stateOf({}), 900, { client: c.client, cacheDir: dir })
    expect(view!.to).toBe(110)
  })

  it('cuts a catch-up window at the event cap like any other', async () => {
    const id = tokenIdOf(tok('MOO') as any)
    const logs = Array.from({ length: 60 }, (_, i) => ({
      address: MINTER,
      blockNumber: `0x${(101 + i * 5).toString(16)}`,
      transactionHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
      logIndex: '0x0',
      topics: encodeEventTopics({ abi: MINTER_ABI, eventName: 'Minted', args: { tokenId: id, to: ALICE, srcTx: `0x${(i + 1).toString(16).padStart(64, '0')}` } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [10n ** 18n]),
    }))
    const view = await evmView(stateOf({}), 900, { client: chain({ head: 2000, logs }).client, cacheDir: dir })
    expect(view!.events.length).toBe(50)
    expect(view!.to).toBe(101 + 49 * 5)
  })

  it('produces byte-identical views on two nodes that read the same chain', async () => {
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'evm-view-'))
    try {
      const a = await evmView(stateOf({ NEW: tok('NEW') }), 900, { client: chain({ paused: true }).client, cacheDir: dir })
      const b = await evmView(stateOf({ NEW: tok('NEW') }), 900, { client: chain({ paused: true }).client, cacheDir: dirB })
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    } finally {
      fs.rmSync(dirB, { recursive: true, force: true })
    }
  })
})

describe('logsAndHead: an endpoint is read whole', () => {
  const asClient = (c: object) => c as unknown as PublicClient

  it('never pairs one endpoint\'s logs with another endpoint\'s head', async () => {
    // A answers the logs (a lagging node's answer may be silently short) and then fails; B must be asked for both.
    const a = asClient({ request: async () => [{ from: 'a' }], getBlockNumber: async () => Promise.reject(new Error('banned')) })
    const b = asClient({ request: async () => [], getBlockNumber: async () => 200n })
    expect(await logsAndHead([a, b], [MINTER], 101, 128, 110)).toEqual({ raw: [], readTo: 128, headNow: 200 })
  })

  it('reads the window alone when an endpoint refuses the wide span, and says so in readTo', async () => {
    let calls = 0
    const a = asClient({
      request: async () => {
        if (calls++ === 0) throw new Error('range too large')
        return []
      },
      getBlockNumber: async () => 130n,
    })
    expect(await logsAndHead([a], [MINTER], 101, 600, 110)).toEqual({ raw: [], readTo: 110, headNow: 130 })
  })

  it('throws the last failure when no endpoint can give both', async () => {
    const down = asClient({ request: async () => Promise.reject(new Error('down')), getBlockNumber: async () => Promise.reject(new Error('down')) })
    await expect(logsAndHead([down, down], [MINTER], 101, 128, 110)).rejects.toThrow('down')
  })
})
