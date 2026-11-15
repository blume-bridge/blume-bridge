/**
 * The cluster's EVM half against the real minter (v3), on a local chain:
 * deploys contracts/src/bridge/ThresholdMinter.sol to anvil with three
 * throwaway operator keys, then drives it through the cluster's own code:
 * queueEvmWork builds the actions, myAttestations signs them on each "node",
 * ingestAttestations gathers them, relayReady simulates and sends, and
 * applyEvmView applies the events the feed would decode. If the typed data or
 * the ABI ever drift from the contract, a listing reverts BadSignature here
 * instead of on a live chain.
 *
 * What it proves
 *  - listing with a logo, a signed metadata update, a mint (as before);
 *  - a mint is refused while the minter is paused (the relay records why and
 *    waits) and lands after k operators sign a resume;
 *  - a token listed with a daily cap of 0 takes no mints until an update
 *    raises the cap; a cap of 2^256-1 means no limit;
 *  - a burn pays the exit fee, the minter keeps exactly the fees, an X-address
 *    destination is accepted, a wrong fee is refused by name;
 *  - k-signed setBurnFee (within the ceiling accepted, above it refused) and
 *    k-signed sweep (and one above the balance refused). These sign with the
 *    typed-data helpers in src/evm.ts, so the helpers are checked against the
 *    contract, not only against our own reading of it.
 *
 *   (cd ../contracts && forge build) && npx tsx scripts/evm-local-check.ts
 *
 * Needs anvil (Foundry). Touches no network but 127.0.0.1, on a free port, and
 * uses keys it generates for the run.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { classicAddressToXAddress } from 'ripple-address-codec'
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, getTypesForEIP712Domain, hashDomain, http, parseAbi, parseEther, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ingestAttestations, myAttestations, relayReady, revertName, type AttCache } from '../src/attest'
import { MAX_BURN_FEE, MINTER_ABI, TOKEN_ABI, UNCAPPED, domain, resumeTyped, setBurnFeeTyped, sweepTyped, tokenIdOf } from '../src/evm'
import type { NodeKeys } from '../src/keys'
import { applyEvmView, queueEvmAction, queueEvmWork } from '../src/machine'
import type { EvmEvent, State, TokenRec } from '../src/types'
import genesis from '../genesis/dev.json'

const CHAIN_ID = 1449000
const BURN_FEE = parseEther('0.25')
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const LOGO = 'https://arweave.net/aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-abcde'
const LOGO2 = 'https://arweave.net/zYxWvUtSrQpOnMlKjIhGfEdCbA9876543210-_edcba'
const ONE = 10n ** 18n

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAILED: ${what}`)
  console.log(`  ok  ${what}`)
}

/** A port nothing is listening on, so a run never collides with another anvil. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

const tokenRec = (sym: string, ticker: string, name: string, extra: Partial<TokenRec> = {}): TokenRec => ({
  sym,
  ticker,
  name,
  issuer: ISSUER,
  currency: Buffer.from(sym).toString('hex').toUpperCase().padEnd(40, '0'),
  status: 'listed',
  lane: 'issuer',
  capUnits: '0',
  lockedUnits: '0',
  dustUnits: '0',
  ...extra,
})

async function main() {
  const artifact = path.join(__dirname, '..', '..', 'contracts', 'out', 'ThresholdMinter.sol', 'ThresholdMinter.json')
  if (!fs.existsSync(artifact)) throw new Error(`${artifact} missing: run forge build in contracts/ first`)
  const bytecode = JSON.parse(fs.readFileSync(artifact, 'utf8')).bytecode.object as Hex
  const port = await freePort()
  const RPC = `http://127.0.0.1:${port}`
  const anvil = spawn('anvil', ['--port', String(port), '--chain-id', String(CHAIN_ID), '--silent'], { stdio: 'ignore' })
  try {
    const chain = { id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'XRP', symbol: 'XRP', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
    const pub = createPublicClient({ chain, transport: http(RPC) })
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getBlockNumber()
        break
      } catch {
        await sleep(100)
      }
    }

    // Throwaway keys, funded by anvil for this run only.
    const opKeys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()]
    const deployerKey = generatePrivateKey()
    const burnerKey = generatePrivateKey()
    const burner = privateKeyToAccount(burnerKey).address
    const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC) })
    for (const k of [...opKeys, deployerKey, burnerKey]) await test.setBalance({ address: privateKeyToAccount(k).address, value: parseEther('100') })
    const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) })

    const nodes: NodeKeys[] = opKeys.map((k) => ({ xrpl: { seed: '', address: '', publicKey: '' }, evm: { privateKey: k, address: privateKeyToAccount(k).address.toLowerCase() }, createdAt: 0 }))
    const signers = nodes.map((n) => n.evm.address).sort()
    const hash = await wallet(deployerKey).deployContract({ abi: parseAbi(['constructor(address[] signers_, uint8 threshold_, uint256 rotationDelay_, uint256 burnFee_)']), bytecode, args: [signers as Address[], 2, 3600n, BURN_FEE] })
    const minter = (await pub.waitForTransactionReceipt({ hash })).contractAddress!.toLowerCase() as Address
    console.log(`  minter v3 deployed at ${minter}`)

    // A state that knows the three operators and the local minter, with the dev genesis's tokens and one new one carrying a logo.
    const s: State = { config: { ...(genesis.config as State['config']), k: 2, n: 3, evm: { rpc: [RPC], chainId: CHAIN_ID, minter, windowBlocks: 10, confirmations: 0, maxEventsPerView: 50, pollMs: 1000, gasLimit: 3000000, relayTimeoutMs: 600000 } }, tokens: structuredClone(genesis.tokens) as State['tokens'], transfers: {}, operators: {}, actions: {}, evmActions: {}, accounts: {}, cursor: { ...structuredClone(genesis.cursor), evm: { block: 0, seen: [], synced: true } }, unmatched: [], treasuryXrp: '0', fees: { xrp: '0', xrpByToken: {}, paidXrp: '0', owed: {}, payouts: [] } }
    const cfg = s.config.evm!
    nodes.forEach((n, i) => (s.operators[`ed${i}`] = { node: `ed${i}`, xrplAddress: `r${i}`, xrplPublicKey: `ED${i}`, evmAddress: n.evm.address }))
    s.tokens.MOO = tokenRec('MOO', 'Moo', 'Moo Token', { image: LOGO, capUnits: '50000' })

    const caches = nodes.map(() => ({}) as AttCache)
    let lcl = 1000
    /** Every node signs every pending action, the signatures cross "NPL", and whichever node is each action's relayer sends it. A relay error fails the run unless `allow` names it. */
    const relayAll = async (allow?: RegExp): Promise<string[]> => {
      const msgs = await Promise.all(nodes.map((n, i) => myAttestations(s, n, caches[i])))
      const received = msgs.flatMap((m, i) => m.map((att) => ({ node: `ed${i}`, att })))
      for (let i = 0; i < nodes.length; i++) await ingestAttestations(s, caches[i], received)
      const notes = (await Promise.all(nodes.map((n, i) => relayReady(s, n, caches[i], lcl++)))).flat()
      for (const n of notes) console.log(`     relay: ${n}`)
      const bad = notes.find((n) => /relay error/.test(n) && !allow?.test(n))
      if (bad) throw new Error(`a relay failed: ${bad}`)
      await sleep(100)
      return notes
    }
    /** What the EVM feed would read from the minter and the tokens, applied the way the cluster applies it. */
    const applyLogs = async () => {
      const head = Number(await pub.getBlockNumber({ cacheTime: 0 }))
      const addrs = [minter, ...Object.values(s.tokens).flatMap((t) => (t.evmAddress ? [t.evmAddress] : []))] as Hex[]
      const logs = await pub.getLogs({ address: addrs, fromBlock: BigInt(s.cursor.evm!.block + 1), toBlock: BigInt(head) })
      const events: EvmEvent[] = []
      for (const l of logs) {
        try {
          const d = decodeEventLog({ abi: MINTER_ABI, data: l.data, topics: l.topics }) as any
          const base = { tx: l.transactionHash!.toLowerCase(), block: Number(l.blockNumber), logIndex: Number(l.logIndex), tokenId: d.args.tokenId?.toLowerCase() }
          if (d.eventName === 'Listed') events.push({ kind: 'listed', ...base, token: d.args.token.toLowerCase(), symbol: d.args.symbol, dailyCapWei: d.args.dailyCap.toString() })
          if (d.eventName === 'Updated') events.push({ kind: 'updated', ...base, token: d.args.token.toLowerCase(), dailyCapWei: d.args.dailyCap.toString(), nonce: d.args.nonce.toString() })
          if (d.eventName === 'Minted') events.push({ kind: 'mint', ...base, to: d.args.to.toLowerCase(), amountWei: d.args.amount.toString(), srcTx: d.args.srcTx.toLowerCase() })
        } catch {
          /* a token's Transfer or Burn */
        }
      }
      const r = applyEvmView(s, { src: 'evm', from: s.cursor.evm!.block, to: head, events, listings: {} }, Date.now())
      Object.assign(s, r.state)
      for (const a of r.applied) console.log(`     applied: ${a.kind} ${a.detail}`)
    }

    const read = (functionName: string, args: unknown[] = []) => pub.readContract({ address: minter, abi: MINTER_ABI, functionName, args } as any)
    const minted = (srcTx: string) => read('minted', [srcTx]) as Promise<boolean>
    const balanceOf = (token: string, who: string) => pub.readContract({ address: token as Address, abi: TOKEN_ABI, functionName: 'balanceOf', args: [who as Address] }) as Promise<bigint>
    const erc20 = (address: string) => ({
      name: () => pub.readContract({ address: address as Hex, abi: parseAbi(['function name() view returns (string)']), functionName: 'name' }),
      symbol: () => pub.readContract({ address: address as Hex, abi: parseAbi(['function symbol() view returns (string)']), functionName: 'symbol' }),
      imageURI: () => pub.readContract({ address: address as Hex, abi: parseAbi(['function imageURI() view returns (string)']), functionName: 'imageURI' }),
    })
    /** A minter call from `key`, mined; throws when it reverts. */
    const send = async (key: Hex, functionName: string, args: unknown[] = []) => {
      const tx = await wallet(key).writeContract({ address: minter, abi: MINTER_ABI, functionName, args } as any)
      const receipt = await pub.waitForTransactionReceipt({ hash: tx })
      if (receipt.status !== 'success') throw new Error(`${functionName} reverted`)
      return receipt
    }
    /** What a call reverts with, by name ('did not revert' when it does not). */
    const revertOf = (call: Promise<unknown>) => call.then(() => 'did not revert', (e) => revertName(e) ?? String(e?.shortMessage ?? e))
    /** k signatures from the first two operators in ascending address order, which is the order the minter wants them. */
    const twoOps = opKeys.map((k) => privateKeyToAccount(k)).sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1)).slice(0, 2)
    const signK = (typed: any): Promise<Hex[]> => Promise.all(twoOps.map((a) => a.signTypedData(typed)))
    const mintAction = (sym: string, to: string, amount: bigint, srcTx: string) => queueEvmAction(s, 'mint', { tokenId: tokenIdOf(s.tokens[sym]), to, amount: amount.toString(), srcTx }, { kind: 'mint', transferId: `local-${srcTx.slice(2, 6)}` }, Date.now())
    const submittedKind = (kind: string) => caches.flatMap((c) => Object.values(c)).find((e) => e.submitted?.kind === kind)?.submitted

    const dom = domain(cfg)
    check((await read('domainSeparator')) === hashDomain({ domain: dom, types: { EIP712Domain: getTypesForEIP712Domain({ domain: dom }) } } as any),'the cluster signs for the minter\'s own domain (BlumeBridge, version 3, this chain and address)')
    check((await read('burnFee')) === BURN_FEE && (await read('MAX_BURN_FEE')) === MAX_BURN_FEE && (await read('UNCAPPED')) === UNCAPPED, 'the constructor fee, the fee ceiling and UNCAPPED are what src/evm.ts says')

    console.log('  listing every listed token (queueEvmWork → attest → relay)')
    queueEvmWork(s, Date.now())
    await relayAll()
    await applyLogs()
    const moo = s.tokens.MOO
    check(!!moo.evmAddress, 'MOO has an ERC-20')
    const t = erc20(moo.evmAddress!)
    check((await t.name()) === 'Moo Token' && (await t.symbol()) === 'Moo' && (await t.imageURI()) === LOGO, `MOO carries its name, its symbol and its logo on chain (${await t.name()} / ${await t.symbol()} / ${await t.imageURI()})`)
    const cap = (await read('caps', [moo.evmAddress])) as readonly bigint[]
    check(cap[0] === 50000n * ONE, `MOO's daily cap is the listed 50000 (${cap[0]})`)
    check(moo.capUnits === '50000', `the cluster mirrors that cap (${moo.capUnits})`)
    check(!!s.tokens.PETAL.evmAddress && (await erc20(s.tokens.PETAL.evmAddress!).imageURI()) === '', 'PETAL, with no logo, lists with an empty imageURI')

    console.log('  the issuer changes the name and the logo (metaVersion → update → attest → relay)')
    moo.name = 'Moo Finance'
    moo.image = LOGO2
    moo.metaVersion = 1
    queueEvmWork(s, Date.now())
    check(!!moo.evmUpdateActionId, 'an update action is queued')
    await relayAll()
    await applyLogs()
    check((await t.name()) === 'Moo Finance' && (await t.imageURI()) === LOGO2, `the ERC-20 now says ${await t.name()} with the new logo`)
    // applyEvmView hands back a new state: read the token again rather than through the old reference.
    const after = s.tokens.MOO
    check((await read('metaNonce', [tokenIdOf(after)])) === 1n && after.evmMetaNonce === 1 && after.evmMetaVersion === 1 && !after.evmUpdateActionId, 'the minter is at nonce 1 and the cluster agrees')

    console.log('  a mint')
    const beef = '0x000000000000000000000000000000000000beef'
    mintAction('MOO', beef, 25n * ONE, `0x${'ab'.repeat(32)}`)
    await relayAll()
    check((await balanceOf(after.evmAddress!, beef)) === 25n * ONE, 'the mint landed: 25 MOO')

    console.log('  one operator pauses; a mint is held, then relayed after k operators sign a resume')
    check((await revertOf(pub.simulateContract({ address: minter, abi: MINTER_ABI, functionName: 'pause', account: burner }))) === 'NotSigner', 'a key that is not a signer cannot pause (NotSigner)')
    await send(opKeys[0], 'pause')
    check((await read('paused')) === true, 'paused() is true after one signer pauses, with no signatures')
    const heldTx = `0x${'cd'.repeat(32)}`
    mintAction('MOO', burner, 100n * ONE, heldTx)
    await relayAll(/relay error \(paused\)/)
    check(!(await minted(heldTx)), 'the mint is refused while the minter is paused')
    const heldWhy = submittedKind('paused')
    check(!!heldWhy && /IsPaused/.test(heldWhy.error ?? ''), `the relay recorded why, as a condition to wait out: kind paused, "${heldWhy?.error}"`)
    const resumeNonce = (await read('resumeNonce')) as bigint
    check((await revertOf(pub.simulateContract({ address: minter, abi: MINTER_ABI, functionName: 'resume', args: [resumeNonce, await signK(resumeTyped(cfg, resumeNonce + 1n))], account: burner }))) === 'BadSignature', 'signatures made for another nonce do not resume the minter (BadSignature)')
    check((await revertOf(pub.simulateContract({ address: minter, abi: MINTER_ABI, functionName: 'resume', args: [resumeNonce + 1n, await signK(resumeTyped(cfg, resumeNonce + 1n))], account: burner }))) === 'BadNonce', 'nor does a resume that names a nonce the minter is not at (BadNonce)')
    await send(burnerKey, 'resume', [resumeNonce, await signK(resumeTyped(cfg, resumeNonce))])
    check((await read('paused')) === false && (await read('resumeNonce')) === resumeNonce + 1n, 'two operators\' signatures resume the minter, sent by a key that is not a signer')
    lcl += 10
    await relayAll()
    check((await minted(heldTx)) && (await balanceOf(after.evmAddress!, burner)) === 100n * ONE, 'the held mint lands after the resume: 100 MOO')

    console.log('  a token listed with a daily cap of 0 takes no mints until an update raises the cap')
    s.tokens.ZERO = tokenRec('ZERO', 'Zero', 'Zero Token')
    const listZero = queueEvmAction(s, 'list', { tokenId: tokenIdOf(s.tokens.ZERO), name: 'Zero Token', symbol: 'Zero', imageURI: '', dailyCap: '0' }, { kind: 'list', sym: 'ZERO' }, Date.now())
    s.tokens.ZERO.evmActionId = listZero.id
    await relayAll()
    await applyLogs()
    const zero = s.tokens.ZERO
    check(!!zero.evmAddress && ((await read('caps', [zero.evmAddress])) as readonly bigint[])[0] === 0n, 'ZERO is listed with a daily cap of 0')
    const zeroTx = `0x${'ef'.repeat(32)}`
    mintAction('ZERO', beef, 5n * ONE, zeroTx)
    await relayAll(/relay error \(cap-day\)/)
    const capWhy = submittedKind('cap-day')
    check(!(await minted(zeroTx)) && !!capWhy && /CapExceeded/.test(capWhy.error ?? ''), `a cap of 0 refuses the mint, and the relay calls it a condition to wait out: "${capWhy?.error}"`)
    zero.capUnits = '1000'
    zero.metaVersion = 1
    queueEvmWork(s, Date.now())
    check(!!zero.evmUpdateActionId, 'an update raising the cap is queued')
    await relayAll()
    await applyLogs()
    check(((await read('caps', [zero.evmAddress])) as readonly bigint[])[0] === 1000n * ONE, 'a k-signed update raised the cap to 1000')
    lcl += 100
    await relayAll()
    check((await minted(zeroTx)) && (await balanceOf(zero.evmAddress!, beef)) === 5n * ONE, 'the mint the cap of 0 refused lands once the cap is raised')

    console.log('  a cap of 2^256-1 means no limit')
    queueEvmAction(s, 'update', { tokenId: tokenIdOf(s.tokens.ZERO), name: 'Zero Token', symbol: 'Zero', imageURI: '', dailyCap: UNCAPPED.toString(), nonce: '2' }, { kind: 'update', sym: 'ZERO', nonce: 2 }, Date.now())
    await relayAll()
    check(((await read('caps', [zero.evmAddress])) as readonly bigint[])[0] === UNCAPPED, 'the cluster signed and relayed an update to UNCAPPED')
    const bigTx = `0x${'12'.repeat(32)}`
    mintAction('ZERO', beef, 1_000_000n * ONE, bigTx)
    await relayAll()
    check((await minted(bigTx)) && (await balanceOf(zero.evmAddress!, beef)) === 1_000_005n * ONE, 'a mint of a million tokens passes an uncapped token, and counting it did not overflow')

    console.log('  burning pays the exit fee; the minter keeps exactly the fees')
    const mooAddr = after.evmAddress as Address
    const burn = (key: Hex, to: string, value: bigint, amount = ONE) => wallet(key).writeContract({ address: mooAddr, abi: TOKEN_ABI, functionName: 'burn', args: [amount, to], value })
    const burnCall = (to: string, value: bigint, amount = ONE) => pub.simulateContract({ address: mooAddr, abi: TOKEN_ABI, functionName: 'burn', args: [amount, to], value, account: burner })
    const burnAndWait = async (to: string, value: bigint) => pub.waitForTransactionReceipt({ hash: await burn(burnerKey, to, value) })
    check((await pub.getBalance({ address: minter })) === 0n, 'the minter holds no XRP before any burn')
    check((await revertOf(burnCall(ISSUER, 0n))) === 'BadFeePayment', 'a burn that carries no fee is refused (BadFeePayment)')
    check((await revertOf(burnCall(ISSUER, BURN_FEE + 1n))) === 'BadFeePayment', 'a burn that carries too much is refused too: the fee is exact')
    await burnAndWait(ISSUER, BURN_FEE)
    check((await pub.getBalance({ address: minter })) === BURN_FEE && (await balanceOf(mooAddr, burner)) === 99n * ONE, 'a classic-address burn pays the 0.25 XRP fee into the minter and burns the token')
    const xTest = classicAddressToXAddress(ISSUER, 12345, true)
    const xMain = classicAddressToXAddress(ISSUER, false, false)
    check(xTest.length === 47 && xTest.startsWith('T') && xMain.length === 47 && xMain.startsWith('X'), `the X-addresses are 47 characters (${xTest.slice(0, 6)}…, ${xMain.slice(0, 6)}…)`)
    const xReceipt = await burnAndWait(xTest, BURN_FEE)
    const burnEvent = xReceipt.logs.map((l) => { try { return decodeEventLog({ abi: TOKEN_ABI, data: l.data, topics: l.topics }) } catch { return null } }).find((d) => d?.eventName === 'Burn') as any
    check(burnEvent?.args.rAddress === xTest, 'a test-network X-address is accepted and echoed in the Burn event for the cluster to decode')
    await burnAndWait(xMain, BURN_FEE)
    check((await revertOf(burnCall(xMain.slice(0, 46), BURN_FEE))) === 'BadAddress', 'an X-address one character short is refused (BadAddress)')
    check((await pub.getBalance({ address: minter })) === 3n * BURN_FEE, 'the minter holds exactly the three fees paid')

    console.log('  k operators change the exit fee, within the ceiling')
    const feeNonce = (await read('feeNonce')) as bigint
    const newFee = parseEther('0.5')
    await send(burnerKey, 'setBurnFee', [{ burnFee: newFee, nonce: feeNonce }, await signK(setBurnFeeTyped(cfg, newFee, feeNonce))])
    check((await read('burnFee')) === newFee && (await read('feeNonce')) === feeNonce + 1n, 'a k-signed setBurnFee moves the fee to 0.5 XRP')
    check((await revertOf(burnCall(ISSUER, BURN_FEE))) === 'BadFeePayment', 'the old fee no longer pays a burn')
    await burnAndWait(ISSUER, newFee)
    check((await pub.getBalance({ address: minter })) === 3n * BURN_FEE + newFee, 'a burn at the new fee is accepted and the minter\'s balance is the sum of every fee paid')
    const tooHigh = MAX_BURN_FEE + 1n
    check((await revertOf(pub.simulateContract({ address: minter, abi: MINTER_ABI, functionName: 'setBurnFee', args: [{ burnFee: tooHigh, nonce: feeNonce + 1n }, await signK(setBurnFeeTyped(cfg, tooHigh, feeNonce + 1n))], account: burner }))) === 'BadFee', 'a fee above the 1 XRP ceiling is refused even with k valid signatures (BadFee)')

    console.log('  k operators sweep the fee revenue')
    const balance = await pub.getBalance({ address: minter })
    const [r1, r2] = [privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address]
    const [a1, a2] = [parseEther('0.4'), parseEther('0.35')]
    const sweepNonce = (await read('sweepNonce')) as bigint
    await send(burnerKey, 'sweep', [{ to: [r1, r2], amounts: [a1, a2], nonce: sweepNonce }, await signK(sweepTyped(cfg, [r1, r2], [a1, a2], sweepNonce))])
    check((await pub.getBalance({ address: r1 })) === a1 && (await pub.getBalance({ address: r2 })) === a2 && (await pub.getBalance({ address: minter })) === balance - a1 - a2, 'a k-signed sweep pays both recipients out of the minter')
    const swept = await pub.getContractEvents({ address: minter, abi: MINTER_ABI, eventName: 'Swept', fromBlock: 0n })
    check(swept.length === 1 && swept[0].args.nonce === sweepNonce && swept[0].args.to?.length === 2, 'the Swept event names the payments')
    const rest = balance - a1 - a2
    check((await revertOf(pub.simulateContract({ address: minter, abi: MINTER_ABI, functionName: 'sweep', args: [{ to: [r1], amounts: [rest + 1n], nonce: sweepNonce + 1n }, await signK(sweepTyped(cfg, [r1], [rest + 1n], sweepNonce + 1n))], account: burner }))) === 'SweepFailed', 'a sweep above the minter\'s balance is refused (SweepFailed)')
    check((await revertOf(pub.simulateContract({ address: minter, abi: MINTER_ABI, functionName: 'sweep', args: [{ to: [r1], amounts: [1n], nonce: sweepNonce }, await signK(sweepTyped(cfg, [r1], [1n], sweepNonce))], account: burner }))) === 'BadNonce', 'a sweep signed for a spent nonce is refused (BadNonce)')

    console.log('\n  PASSED: the cluster lists, updates, mints, waits out a pause and a zero cap, and the fee, sweep and resume signatures verify on the v3 minter')
  } finally {
    anvil.kill()
  }
}

main().catch((e) => {
  console.error('ERROR', e?.shortMessage ?? e?.message ?? e)
  process.exit(1)
})
