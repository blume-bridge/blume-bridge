import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { encodeFunctionData, keccak256, parseAbi, toBytes } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BURN_TOPIC, paymentsInto, reconcile, releasedBurns, sentBy } from '../scripts/reconcile-snapshot'
import { PKG, cleanupTmp, runAsync, tmpDir } from './ops-helpers'

afterAll(cleanupTmp)

const LOCK = 'rLockAccountXXXXXXXXXXXXXXXXXXXX'
const FUND = 'rFundingAccountXXXXXXXXXXXXXXXXXX'
const hexUpper = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
const burnTx = (n: number) => `0x${n.toString(16).padStart(64, 'a')}`
const release = (burn: string, hash: string, over: Record<string, unknown> = {}, result = 'tesSUCCESS', shape: 'tx' | 'tx_json' = 'tx_json') => {
  const tx = { TransactionType: 'Payment', Account: LOCK, Destination: 'rUser', Amount: '1000000', Memos: [{ Memo: { MemoType: hexUpper('blume/burn'), MemoData: hexUpper(burn) } }], ...over }
  return { hash, validated: true, ledger_index: 100, meta: { TransactionResult: result }, [shape]: tx }
}
const lockIn = (hash: string, over: Record<string, unknown> = {}) => ({ hash, validated: true, ledger_index: 101, meta: { TransactionResult: 'tesSUCCESS' }, tx_json: { TransactionType: 'Payment', Account: 'rUser', Destination: LOCK, Amount: '5', ...over } })

describe('reading the lock account', () => {
  it('knows the Burn topic is the keccak of the event signature', async () => {
    expect(BURN_TOPIC).toBe(keccak256(toBytes('Burn(address,uint256,string,uint256)')))
  })

  it('finds which burns a release paid, in either response shape, and only successful ones', async () => {
    const entries = [
      release(burnTx(1), 'AAA1'),
      release(burnTx(2), 'AAA2', {}, 'tesSUCCESS', 'tx'),
      release(burnTx(3), 'AAA3', {}, 'tecNO_DST'),
      release(burnTx(4), 'AAA4', { Account: 'rSomeoneElse' }),
      release(burnTx(5), 'AAA5', { TransactionType: 'TrustSet' }),
      { ...release(burnTx(6), 'AAA6'), validated: false },
      release(burnTx(7).toUpperCase().replace('0X', '0x'), 'aaa7'),
      lockIn('BBB1'),
    ]
    const r = releasedBurns(entries as never, LOCK)
    expect([...r.keys()].sort()).toEqual([burnTx(1), burnTx(2), burnTx(7)].map((x) => x.toLowerCase()).sort())
    expect(r.get(burnTx(1))).toBe('AAA1')
    expect(r.get(burnTx(7).toLowerCase())).toBe('AAA7')
  })

  it('ignores memos that are not a burn memo', async () => {
    const other = release(burnTx(1), 'AAA1', { Memos: [{ Memo: { MemoType: hexUpper('something/else'), MemoData: hexUpper(burnTx(1)) } }] })
    expect(releasedBurns([other] as never, LOCK).size).toBe(0)
    expect(releasedBurns([release(burnTx(1), 'A', { Memos: undefined })] as never, LOCK).size).toBe(0)
  })

  it('lists payments into an account and what an account sent', async () => {
    const entries = [lockIn('BBB1'), lockIn('BBB2', { Destination: 'rElse' }), release(burnTx(1), 'AAA1'), { ...lockIn('BBB3'), meta: { TransactionResult: 'tecPATH_DRY' } }]
    expect(paymentsInto(entries as never, LOCK)).toEqual([{ tx: 'BBB1', ledger: 101 }])
    expect(sentBy(entries as never, LOCK)).toEqual([{ tx: 'AAA1', type: 'Payment', ledger: 100 }])
    expect(sentBy(entries as never, FUND)).toEqual([])
  })
})

describe('reconcile', () => {
  const burn = (n: number, logIndex = 0, token = 'PETAL') => ({ tx: burnTx(n), logIndex, token })
  it('guards the burns that were released and leaves the others for the cluster', async () => {
    const released = new Map([[burnTx(1), 'REL1'], [burnTx(3), 'REL3']])
    const r = reconcile([], { released, burns: [burn(1), burn(2), burn(3, 2)] })
    expect(r.add).toEqual([`${burnTx(1)}:0`, `${burnTx(3)}:2`])
    expect(r.unreleased.map((b) => b.tx)).toEqual([burnTx(2)])
    expect(r.releasedBurns.map((b) => b.release)).toEqual(['REL1', 'REL3'])
  })
  it('does not add what the snapshot already skips, or the same key twice', async () => {
    const released = new Map([[burnTx(1), 'REL1']])
    const r = reconcile([`${burnTx(1)}:0`], { released, burns: [burn(1), burn(1)] })
    expect(r.add).toEqual([])
    expect(r.alreadyGuarded).toEqual([`${burnTx(1)}:0`, `${burnTx(1)}:0`])
    const twice = reconcile([], { released, burns: [burn(1), burn(1)] })
    expect(twice.add).toEqual([`${burnTx(1)}:0`])
  })
  it('matches a burn by its hash whatever the case', async () => {
    const released = new Map([[burnTx(1).toLowerCase(), 'REL']])
    expect(reconcile([], { released, burns: [{ tx: burnTx(1).toUpperCase().replace('0X', '0x'), logIndex: 4, token: 'MOO' }] }).add).toEqual([`${burnTx(1)}:4`])
  })
  it('with nothing released adds nothing', async () => {
    expect(reconcile([], { released: new Map(), burns: [burn(1), burn(2)] }).add).toEqual([])
  })
})

// ------------------------------------------------------------------ end to end, against fake chains

describe('reconcile-snapshot.ts against fake chains', () => {
  let xrpl: http.Server
  let evm: http.Server
  let xrplUrl = ''
  let evmUrl = ''
  const TOKEN = '0x00000000000000000000000000000000000000aa'
  const MINTER = '0x00000000000000000000000000000000000000bb'
  const mintedAbi = parseAbi(['function minted(bytes32) view returns (bool)'])
  const world = {
    lockTxs: [] as unknown[],
    fundingTxs: [] as unknown[],
    burns: [] as { tx: string; logIndex: number; block: number }[],
    minted: new Set<string>(),
    head: 200,
    pageSize: 1000,
  }

  const serve = (handler: (body: any) => unknown) =>
    new Promise<http.Server>((resolve) => {
      const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(handler(JSON.parse(raw))))
        })
      })
      server.listen(0, '127.0.0.1', () => resolve(server))
    })

  beforeAll(async () => {
    xrpl = await serve((body) => {
      const p = body.params[0]
      if (body.method !== 'account_tx') return { result: { status: 'error', error: 'unknownCmd' } }
      const all = (p.account === LOCK ? world.lockTxs : world.fundingTxs) as unknown[]
      const start = p.marker ? Number(p.marker) : 0
      const page = all.slice(start, start + world.pageSize)
      return { result: { status: 'success', transactions: page, ...(start + world.pageSize < all.length ? { marker: String(start + world.pageSize) } : {}) } }
    })
    evm = await serve((body) => {
      if (body.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: 1, result: `0x${world.head.toString(16)}` }
      if (body.method === 'eth_getLogs') {
        const f = body.params[0]
        const from = Number(f.fromBlock)
        const to = Number(f.toBlock)
        if (f.topics[0] !== BURN_TOPIC || f.address.toLowerCase() !== TOKEN) return { jsonrpc: '2.0', id: 1, result: [] }
        return { jsonrpc: '2.0', id: 1, result: world.burns.filter((b) => b.block >= from && b.block <= to).map((b) => ({ transactionHash: b.tx, logIndex: `0x${b.logIndex.toString(16)}`, blockNumber: `0x${b.block.toString(16)}` })) }
      }
      if (body.method === 'eth_call') {
        const data = body.params[0].data as string
        const hit = [...world.minted].some((tx) => data === encodeFunctionData({ abi: mintedAbi, functionName: 'minted', args: [`0x${tx.toLowerCase().padStart(64, '0')}`] }))
        return { jsonrpc: '2.0', id: 1, result: `0x${hit ? '1'.padStart(64, '0') : '0'.repeat(64)}` }
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

  function snapshotFile(over: Record<string, unknown> = {}) {
    const dir = tmpDir()
    const file = path.join(dir, 'snapshot.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        config: { n: 5, k: 3, xrpl: { rpc: [xrplUrl], lockAccount: LOCK, fundingAccount: FUND }, evm: { rpc: [evmUrl], minter: MINTER } },
        tokens: { PETAL: { sym: 'PETAL', evmAddress: TOKEN }, MOO: { sym: 'MOO' }, XRP: { sym: 'XRP', native: true } },
        cursor: { xrpl: { ledger: 90, seen: [] }, evm: { block: 100, seen: ['0xold:0'] } },
        fees: { xrp: '10', paidXrp: '4' },
        ...over,
      }),
    )
    return file
  }
  const reconcileCli = (file: string, args: string[] = []) => runAsync('npx', ['--no-install', 'tsx', path.join(PKG, 'scripts/reconcile-snapshot.ts'), file, ...args])
  const reset = () => {
    world.lockTxs = []
    world.fundingTxs = []
    world.burns = []
    world.minted = new Set()
    world.pageSize = 1000
  }

  it('reports which burns the ledger shows as paid and adds only those with --write', async () => {
    reset()
    world.burns = [{ tx: burnTx(1), logIndex: 0, block: 120 }, { tx: burnTx(2), logIndex: 1, block: 130 }, { tx: burnTx(3), logIndex: 0, block: 99 }]
    world.lockTxs = [release(burnTx(1), 'REL1'), lockIn('LOCK1'), lockIn('LOCK2')]
    const file = snapshotFile()
    const report = await reconcileCli(file)
    expect(report.status, report.out).toBe(0)
    // the burn before the cursor is not looked at; one is released, one is not
    expect(report.out).toMatch(/burns since EVM block 100 \(head 200\): 2/)
    expect(report.out).toMatch(/PETAL burn 0xaaaaaaaaaa\.\. already released by REL1\.\.: will be skipped/)
    expect(report.out).toMatch(/PETAL burn 0xaaaaaaaaaa\.\. has no release on the ledger: the restored cluster will release it/)
    expect(report.out).toMatch(/lock account rLock.*: 2 payment\(s\) in and 1 release\(s\) out/)
    expect(report.out).toMatch(/1 released burn\(s\) would be added.*--write/)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).cursor.evm.seen).toEqual(['0xold:0'])

    const written = await reconcileCli(file, ['--write'])
    expect(written.status, written.out).toBe(0)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).cursor.evm.seen).toEqual(['0xold:0', `${burnTx(1)}:0`])
    expect(fs.existsSync(`${file}.pre-reconcile`)).toBe(true)
    expect(JSON.parse(fs.readFileSync(`${file}.pre-reconcile`, 'utf8')).cursor.evm.seen).toEqual(['0xold:0'])
    // run again: nothing left to add
    const again = await reconcileCli(file, ['--write'])
    expect(again.out).toMatch(/already skipped by the snapshot/)
    expect(again.out).toMatch(/nothing to add/)
  })

  it('reads every page of the lock account', async () => {
    reset()
    world.pageSize = 2
    world.lockTxs = Array.from({ length: 7 }, (_, i) => (i % 2 ? release(burnTx(i), `REL${i}`) : lockIn(`LOCK${i}`)))
    world.burns = [{ tx: burnTx(5), logIndex: 0, block: 150 }]
    const r = await reconcileCli(snapshotFile())
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/4 payment\(s\) in and 3 release\(s\) out/)
    expect(r.out).toMatch(/already released by REL5/)
  })

  it('says which locks are already minted and warns about the funding account', async () => {
    reset()
    world.lockTxs = [lockIn('C'.repeat(64)), lockIn('D'.repeat(64))]
    world.minted = new Set(['C'.repeat(64)])
    world.fundingTxs = [{ hash: 'PAY1', validated: true, ledger_index: 120, meta: { TransactionResult: 'tesSUCCESS' }, tx_json: { TransactionType: 'Batch', Account: FUND } }]
    const r = await reconcileCli(snapshotFile())
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/1 lock\(s\) since the cursor are already minted.*AlreadyMinted/)
    expect(r.out).toMatch(/WARNING: the funding account .* sent 1 transaction\(s\) since ledger 90 \(Batch\).*fees\.paidXrp \(4\)/)
  })

  it('has nothing to say about a quiet chain', async () => {
    reset()
    const r = await reconcileCli(snapshotFile())
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/burns since EVM block 100 \(head 200\): 0/)
    expect(r.out).toMatch(/the funding account sent nothing/)
    expect(r.out).toMatch(/nothing to add/)
  })

  it('a snapshot with no EVM side only has the funding check to make', async () => {
    reset()
    const file = snapshotFile({ config: { n: 5, k: 3, xrpl: { rpc: [xrplUrl], lockAccount: LOCK, fundingAccount: FUND } } })
    const r = await reconcileCli(file)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/no EVM side/)
  })

  it('fails loudly when it cannot read the ledger, and on an unknown argument', async () => {
    reset()
    const dead = snapshotFile({ config: { n: 5, k: 3, xrpl: { rpc: ['http://127.0.0.1:1'], lockAccount: LOCK, fundingAccount: FUND } } })
    const r = await reconcileCli(dead)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/ERROR/)
    expect((await reconcileCli(snapshotFile(), ['--force'])).out).toMatch(/unknown argument --force/)
  }, 30_000)

  it('reads the endpoints from the environment when asked', async () => {
    reset()
    const file = snapshotFile({ config: { n: 5, k: 3, xrpl: { rpc: ['http://127.0.0.1:1'], lockAccount: LOCK, fundingAccount: FUND }, evm: { rpc: ['http://127.0.0.1:1'], minter: MINTER } } })
    const r = await runAsync('npx', ['--no-install', 'tsx', path.join(PKG, 'scripts/reconcile-snapshot.ts'), file], { env: { XRPL_RPC: xrplUrl, EVM_RPC: evmUrl } })
    expect(r.status, r.out).toBe(0)
  })
})
