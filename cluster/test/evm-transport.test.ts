import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Hex } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'
import { publicClient, walletClient } from '../src/evm'
import type { EvmConfig } from '../src/types'

const MINTER = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const cfgFor = (...urls: string[]): EvmConfig => ({ rpc: urls, chainId: 1449000, minter: MINTER, windowBlocks: 10, confirmations: 2, maxEventsPerView: 50, pollMs: 8000, gasLimit: 1500000, relayTimeoutMs: 180000 })

type Reply = { status?: number; json?: unknown } | 'hang'
interface Endpoint {
  url: string
  /** The JSON-RPC methods it was asked, in order. */
  calls: string[]
  close: () => Promise<void>
}

const open: Endpoint[] = []

/** A JSON-RPC endpoint on localhost. Answers 0x10 to everything unless `reply` says otherwise. */
async function endpoint(reply: (req: { id: number; method: string }) => Reply): Promise<Endpoint> {
  const calls: string[] = []
  const sockets = new Set<Socket>()
  const server = http.createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      const body = JSON.parse(data) as { id: number; method: string }
      calls.push(body.method)
      const r = reply(body)
      if (r === 'hang') return
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.json ?? { jsonrpc: '2.0', id: body.id, result: '0x10' }))
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const ep: Endpoint = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy()
        server.close(() => r())
      }),
  }
  open.push(ep)
  return ep
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((e) => e.close()))
})

describe('the EVM clients over every configured endpoint', () => {
  it('hands a call the first endpoint refuses to the next', async () => {
    const a = await endpoint(() => ({ status: 403, json: { message: 'banned' } }))
    const b = await endpoint(() => ({}))
    expect(await publicClient(cfgFor(a.url, b.url), 500, 0).getBlockNumber()).toBe(16n)
    expect(a.calls).toEqual(['eth_blockNumber'])
    expect(b.calls).toEqual(['eth_blockNumber'])
  })

  it('gives up on a hung endpoint after its own timeout, not the whole budget', async () => {
    const a = await endpoint(() => 'hang')
    const b = await endpoint(() => ({}))
    const started = Date.now()
    expect(await publicClient(cfgFor(a.url, b.url), 150, 0).getBlockNumber()).toBe(16n)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(b.calls).toEqual(['eth_blockNumber'])
  })

  it('tries each endpoint once when the retry count is 0, and the call fails', async () => {
    const a = await endpoint(() => ({ status: 503, json: {} }))
    const b = await endpoint(() => ({ status: 503, json: {} }))
    await expect(publicClient(cfgFor(a.url, b.url), 500, 0).getBlockNumber()).rejects.toThrow()
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
  })

  it('goes round every endpoint again retryCount times before it fails', async () => {
    const a = await endpoint(() => ({ status: 503, json: {} }))
    const b = await endpoint(() => ({ status: 503, json: {} }))
    await expect(publicClient(cfgFor(a.url, b.url), 500, 1).getBlockNumber()).rejects.toThrow()
    expect(a.calls).toHaveLength(2)
    expect(b.calls).toHaveLength(2)
  })

  it('treats a revert as the contract\'s answer: no retry, no second endpoint', async () => {
    const a = await endpoint(({ id }) => ({ json: { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } } }))
    const b = await endpoint(() => ({}))
    await expect(publicClient(cfgFor(a.url, b.url), 500, 2).call({ to: MINTER, data: '0x1234' })).rejects.toThrow()
    expect(a.calls).toEqual(['eth_call'])
    expect(b.calls).toEqual([])
  })

  it('reads the block number fresh every time (cacheTime 0)', async () => {
    const a = await endpoint(() => ({}))
    const client = publicClient(cfgFor(a.url), 500, 0)
    await client.getBlockNumber()
    await client.getBlockNumber()
    expect(a.calls).toEqual(['eth_blockNumber', 'eth_blockNumber'])
  })

  it('gives the wallet client the same fallback', async () => {
    const a = await endpoint(() => ({ status: 403, json: {} }))
    const b = await endpoint(() => ({}))
    const { client } = walletClient(cfgFor(a.url, b.url), `0x${'11'.repeat(32)}` as Hex, 500, 0)
    expect(await client.getChainId()).toBe(16)
    expect(a.calls).toEqual(['eth_chainId'])
    expect(b.calls).toEqual(['eth_chainId'])
  })

  it('refuses a config with no endpoint', () => {
    expect(() => publicClient(cfgFor(), 500)).toThrow(/no endpoint/)
  })
})
