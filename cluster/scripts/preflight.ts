import fs from 'node:fs'
import { createPublicClient, fallback, http, parseAbi, formatEther, getAddress, type Address } from 'viem'
import HotPocket from 'hotpocket-js-client'
import * as dec from '../src/dec'
import { configProblems } from '../src/state'
import type { Config, EvmConfig, TokenRec } from '../src/types'
import { genesisPathFor, pickNetwork } from './network'

/**
 * The launch gate: read-only checks that the pieces of a cluster agree before anyone relies on it. Run it against the
 * genesis you are about to boot (or have booted) and again after the SignerLists and the minter exist. It signs nothing,
 * sends nothing and needs no keys. Exit 1 when anything FAILs; WARNs are things to look at.
 *
 *   XRPL_NETWORK=devnet  npx tsx scripts/preflight.ts [--node host:port]
 *   XRPL_NETWORK=mainnet npx tsx scripts/preflight.ts --node bridge-main.blumefi.com:8443 --burn-fee 250000000000000000
 *
 *   --node        a front door or node user port: reads `operators`, which is what the SignerLists and the minter's
 *                 signer set are compared with. Required on mainnet (a run without it fails); a WARN elsewhere.
 *   --burn-fee    the exit fee the minter should have, in wei (default 0.25 XRP)
 *   --min-delay   the least rotation delay, in seconds, that is not a WARN (default 86400)
 */
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const levels = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' } as const
let fails = 0
let warns = 0
function say(level: keyof typeof levels, what: string, detail = ''): void {
  if (level === 'fail') fails++
  if (level === 'warn') warns++
  console.log(`${levels[level]} ${what}${detail ? `: ${detail}` : ''}`)
}
const check = (ok: boolean, what: string, detail = '', otherwise: 'warn' | 'fail' = 'fail') => say(ok ? 'ok' : otherwise, what, ok ? '' : detail)

const LSF_DISABLE_MASTER = 0x00100000
const LSF_DEFAULT_RIPPLE = 0x00800000
const LSF_DEPOSIT_AUTH = 0x01000000
const LSF_REQUIRE_DEST_TAG = 0x00020000

async function xrpl<T = any>(urls: string[], method: string, params: Record<string, unknown>): Promise<T> {
  const errors: string[] = []
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [{ api_version: 2, ...params }] }), signal: AbortSignal.timeout(10000) })
      const body = (await res.json()) as { result?: T & { status?: string; error?: string } }
      if (!body.result || body.result.status === 'error') throw new Error(body.result?.error ?? 'empty result')
      return body.result
    } catch (e) {
      errors.push(`${new URL(url).host}: ${(e as Error).message}`)
      if (/actNotFound/.test((e as Error).message)) break
    }
  }
  throw new Error(errors.join('; '))
}

interface Signers {
  k: number
  n: number
  signers: { node: string; xrplAddress: string; evmAddress: string }[]
  /** The minter the running cluster reads, once its EVM side is on. */
  minter?: string | null
}

/** The operator set from a live cluster, or null without --node. */
async function operatorsFrom(node: string | undefined): Promise<Signers | null> {
  if (!node) return null
  const client = await HotPocket.createClient([`wss://${node}`], await HotPocket.generateKeys())
  if (!(await client.connect())) throw new Error(`cannot connect to ${node}`)
  try {
    return (await client.submitContractReadRequest(JSON.stringify({ type: 'operators', id: 'preflight' }))) as Signers
  } finally {
    await client.close()
  }
}

/** What the running cluster says about its own code (the loader's `code` read), or null without --node. */
async function codeFrom(node: string | undefined): Promise<{ version: number | null; hash: string | null; appHash: string | null; upgraders: string[]; loaded: string; error: string | null } | null> {
  if (!node) return null
  const client = await HotPocket.createClient([`wss://${node}`], await HotPocket.generateKeys())
  if (!(await client.connect())) throw new Error(`cannot connect to ${node}`)
  try {
    const answer = (await client.submitContractReadRequest(JSON.stringify({ type: 'code', id: 'preflight' }))) as { type?: string } | null
    return answer?.type === 'code' ? (answer as never) : null
  } finally {
    await client.close()
  }
}

/** Every server the cluster reads is on this network and tells the same story about a recent ledger: one that does not is a liar or a fork. */
async function serversAgree(urls: string[], network: string): Promise<void> {
  const seqs: { url: string; seq: number; networkId: number | undefined }[] = []
  for (const url of urls) {
    try {
      const info = await xrpl<{ info: { network_id?: number; validated_ledger?: { seq: number } } }>([url], 'server_info', {})
      const seq = info.info.validated_ledger?.seq
      if (seq) seqs.push({ url, seq, networkId: info.info.network_id })
      else say('warn', `XRP Ledger server ${new URL(url).host} reports a validated ledger`, 'it reported none')
    } catch (e) {
      say('warn', `XRP Ledger server ${new URL(url).host} answers`, (e as Error).message)
    }
  }
  if (network === 'mainnet') for (const s of seqs) check(s.networkId === undefined || s.networkId === 0, `XRP Ledger server ${new URL(s.url).host} is on the main network`, `network_id ${s.networkId}`)
  if (seqs.length < 2) return say('warn', 'the XRP Ledger servers agree on a recent ledger', `only ${seqs.length} answered`)
  const at = Math.min(...seqs.map((s) => s.seq)) - 4
  const hashes: string[] = []
  for (const s of seqs) {
    try {
      hashes.push((await xrpl<{ ledger_hash: string }>([s.url], 'ledger', { ledger_index: at })).ledger_hash)
    } catch (e) {
      say('warn', `XRP Ledger server ${new URL(s.url).host} has ledger ${at}`, (e as Error).message)
    }
  }
  check(new Set(hashes).size <= 1, `every XRP Ledger server holds the same ledger ${at}`, `${hashes.length} servers answered with ${new Set(hashes).size} different hashes`)
}

async function xrplSide(cfg: Config, tokens: TokenRec[], ops: Signers | null, network: string): Promise<void> {
  const urls = cfg.xrpl.rpc
  await serversAgree(urls, network)
  const features = await xrpl<{ features: Record<string, { name: string; enabled: boolean }> }>(urls, 'feature', {}).catch(() => null)
  const batch = features && Object.values(features.features).find((f) => f.name === 'BatchV1_1')
  check(!!batch?.enabled, 'the Batch amendment is enabled on this ledger', batch ? 'BatchV1_1 is off' : 'could not read the amendment list')

  const lines: { account: string; currency: string; limit: string; no_ripple?: boolean }[] = []
  for (const [name, addr] of [['lock', cfg.xrpl.lockAccount], ['funding', cfg.xrpl.fundingAccount]] as const) {
    let info: { account_data: { Balance: string; Flags: number; OwnerCount: number; RegularKey?: string }; signer_lists?: { SignerQuorum: number; SignerEntries: { SignerEntry: { Account: string; SignerWeight: number } }[] }[] }
    try {
      info = await xrpl(urls, 'account_info', { account: addr, ledger_index: 'validated', signer_lists: true })
    } catch (e) {
      say('fail', `${name} account ${addr} exists`, (e as Error).message)
      continue
    }
    const a = info.account_data
    const xrp = Number(a.Balance) / 1e6
    const needs = 1 + 0.2 * (a.OwnerCount + (name === 'lock' ? tokens.filter((t) => !t.native).length : 0)) + (name === 'lock' ? 5 : 2)
    check(xrp >= needs, `${name} account holds enough XRP`, `${xrp} XRP, wants about ${needs.toFixed(1)} (reserve for its objects plus working room)`, 'warn')
    const list = info.signer_lists?.[0]
    if (!list) say(network === 'mainnet' ? 'fail' : 'warn', `${name} account has a SignerList`, 'none yet: set it once the nodes have published their keys')
    else {
      const entries = list.SignerEntries.map((e) => ({ account: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight }))
      if (ops) {
        const want = new Set(ops.signers.map((s) => s.xrplAddress))
        const have = new Set(entries.map((e) => e.account))
        const extra = [...have].filter((x) => !want.has(x))
        const missing = [...want].filter((x) => !have.has(x))
        check(missing.length === 0, `${name} SignerList has every operator`, `missing ${missing.join(', ')}`)
        // Entries that are not operators are fine only when they are a recovery signer someone chose on purpose: say so.
        if (extra.length) say('warn', `${name} SignerList has entries that are not operators`, `${extra.join(', ')} (a recovery signer? it should be intended)`)
        const opWeights = entries.filter((e) => want.has(e.account))
        check(opWeights.every((e) => e.weight === 1), `${name} operators each carry weight 1`, JSON.stringify(opWeights))
        check(list.SignerQuorum === ops.k, `${name} SignerList quorum equals k`, `quorum ${list.SignerQuorum}, k ${ops.k}`)
      } else say(network === 'mainnet' ? 'fail' : 'warn', `${name} SignerList compared with the operators`, 'skipped: no --node given, so a SignerList of any keys would pass')
      const alone = entries.filter((e) => e.weight >= list.SignerQuorum)
      check(alone.length === 0, `no single ${name} signer can sign alone`, `${alone.map((e) => e.account).join(', ')} can`)
    }
    // A regular key signs on its own, whatever the SignerList says: it is a second way to move everything.
    check(!a.RegularKey, `${name} account has no regular key`, `${a.RegularKey} can sign alone; remove it (SetRegularKey with no key) before any funds are on the account`, network === 'mainnet' ? 'fail' : 'warn')
    const flags = a.Flags >>> 0
    const masterOff = (flags & LSF_DISABLE_MASTER) !== 0
    // The beta can run with the master keys ON and no recovery signer: with k of n leased nodes, switching them off leaves two lapsed leases as the permanent loss of every locked
    // token. ACCEPT_MASTER_KEYS=1 says that out loud and makes the line a warning; without it a mainnet gate fails. Whoever accepts it must also stop the site claiming that no one key can move the tokens.
    const acceptMaster = process.env.ACCEPT_MASTER_KEYS === '1'
    check(
      masterOff,
      `${name} account's master key is disabled`,
      acceptMaster
        ? 'ACCEPT_MASTER_KEYS=1: the master key stays on as the recovery path (beta). It can move funds alone; switch it off once a recovery signer is on the SignerList and a multisigned payment has worked'
        : 'the account key can still move funds alone; disable it once a first multisigned payment has worked and a recovery signer is on the SignerList',
      network === 'mainnet' && !acceptMaster ? 'fail' : 'warn',
    )
    check((flags & LSF_DEPOSIT_AUTH) === 0 && (flags & LSF_REQUIRE_DEST_TAG) === 0, `${name} account takes plain payments`, 'DepositAuth or RequireDest is set: users could not pay it')
    if (name === 'lock') check((flags & LSF_DEFAULT_RIPPLE) === 0, 'lock account has DefaultRipple off', 'on: new trust lines would ripple by default', 'warn')
    if (name === 'lock') {
      let marker: unknown
      do {
        const page: { lines: typeof lines; marker?: unknown } = await xrpl(urls, 'account_lines', { account: addr, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) })
        lines.push(...page.lines)
        marker = page.marker
      } while (marker)
    }
  }

  const ripples = lines.filter((l) => l.no_ripple !== true)
  check(ripples.length === 0, `every lock-account trust line refuses rippling (${lines.length} lines)`, `${ripples.map((l) => `${l.currency}.${l.account.slice(0, 6)}`).join(', ')} can be rippled through: a same-code token could drain them (scripts/ripple-check.ts)`)
  for (const t of tokens.filter((x) => !x.native && x.currency && x.status === 'listed')) {
    const line = lines.find((l) => l.currency === t.currency && l.account === t.issuer)
    if (!line) say('warn', `lock trust line for ${t.sym}`, 'not open yet (the cluster opens it after the boot)')
    else {
      // The line should be exactly the token's own supply (seed-build.ts reads it), or the default for a token listed without one. Under it, a deposit the token could carry fails on the ledger; over it is harmless.
      const want = t.trustLimit ?? cfg.params.trustLineLimit
      const c = dec.cmp(line.limit, want)
      check(c === 0, `lock trust line limit for ${t.sym}`, `${line.limit} is not ${t.trustLimit ? "the token's supply" : 'the default limit'} ${want}`, c < 0 ? 'fail' : 'warn')
    }
  }
}

const MINTER_ABI = parseAbi([
  'function threshold() view returns (uint8)',
  'function signers() view returns (address[])',
  'function rotationDelay() view returns (uint256)',
  'function burnFee() view returns (uint256)',
  'function MAX_BURN_FEE() view returns (uint256)',
  'function paused() view returns (bool)',
  'function factory() view returns (address)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
])

async function evmSide(evm: EvmConfig | undefined, cfg: Config, ops: Signers | null, network: string): Promise<void> {
  if (!evm) {
    say('warn', 'EVM side configured', cfg.evmPlan ? 'planned in the genesis and not on yet: once the minter is deployed, `scripts/admin.ts evm MINTER FROM` turns it on' : 'the genesis has none (first boot, XRPL only)')
    return
  }
  const client = createPublicClient({ transport: fallback(evm.rpc.map((u) => http(u, { timeout: 10000 }))) })
  const minter = evm.minter as Address
  const chain = await client.getChainId()
  check(chain === evm.chainId, 'the EVM RPC is on the chain the genesis names', `RPC is on ${chain}, genesis says ${evm.chainId}`)
  if (network === 'mainnet') check(evm.chainId === 1440000, 'the genesis names the XRPL EVM mainnet chain', `chain id ${evm.chainId}, mainnet is 1440000`)
  // The cluster asks these servers in turn; one of them on another chain would feed it that chain's logs.
  for (const url of evm.rpc) {
    try {
      const id = await createPublicClient({ transport: http(url, { timeout: 10000 }) }).getChainId()
      check(id === evm.chainId, `EVM server ${new URL(url).host} is on chain ${evm.chainId}`, `it answers chain ${id}`)
    } catch (e) {
      say('warn', `EVM server ${new URL(url).host} answers`, (e as Error).message.split('\n')[0])
    }
  }
  const code = await client.getCode({ address: minter })
  check(!!code && code !== '0x', 'the minter has code', `no contract at ${minter}`)
  if (!code || code === '0x') return
  const read = <F extends (typeof MINTER_ABI)[number]['name']>(fn: F) => client.readContract({ address: minter, abi: MINTER_ABI, functionName: fn } as never) as Promise<any>
  let domain: any, threshold: any, signers: any, delay: any, fee: any, max: any, paused: any
  try {
    ;[domain, threshold, signers, delay, fee, max, paused] = await Promise.all([read('eip712Domain'), read('threshold'), read('signers'), read('rotationDelay'), read('burnFee'), read('MAX_BURN_FEE'), read('paused')])
  } catch (e) {
    say('fail', 'the minter answers the version 3 reads (burnFee, paused, eip712Domain...)', `${minter} is probably an older minter: ${(e as Error).message.split('\n')[0]}`)
    return
  }
  check(domain[2] === '3', 'the minter is version 3', `domain version ${domain[2]}: this cluster signs for 3`)
  check(Number(domain[3]) === evm.chainId && getAddress(domain[4]) === getAddress(minter), 'the minter signs for its own chain and address', `domain says chain ${domain[3]} at ${domain[4]}`)
  check(Number(threshold) === cfg.k, 'the minter threshold equals k', `threshold ${threshold}, k ${cfg.k}`)
  const burnFee = BigInt(flag('burn-fee') ?? '250000000000000000')
  check(fee === burnFee, `the exit fee is ${formatEther(burnFee)} XRP`, `it is ${formatEther(fee)}`)
  check(fee <= max, 'the exit fee is within its ceiling', `${formatEther(fee)} above ${formatEther(max)}`)
  check(!paused, 'mints are not paused', 'the minter is paused: nothing mints until k signers resume it', 'warn')
  const minDelay = Number(flag('min-delay') ?? 86400)
  check(Number(delay) >= minDelay, `the rotation delay is at least ${minDelay} s`, `${delay} s: the window users have to leave before a hostile signer-set change; it can never be changed`, network === 'mainnet' ? 'fail' : 'warn')
  if (ops) {
    const want = new Set(ops.signers.map((s) => s.evmAddress.toLowerCase()))
    const have = new Set((signers as string[]).map((a) => a.toLowerCase()))
    check(want.size === have.size && [...want].every((a) => have.has(a)), "the minter's signers are the operators' EVM addresses", `minter has ${[...have].join(', ')}; operators have ${[...want].join(', ')}`)
    const balances = await Promise.all(ops.signers.map(async (s) => ({ node: s.evmAddress, bal: await client.getBalance({ address: s.evmAddress as Address }) })))
    for (const b of balances) check(b.bal >= 10n ** 18n, `relayer ${b.node.slice(0, 10)}… has gas`, `${formatEther(b.bal)} XRP: a relay needs well under 0.01, but one outage can run long`, 'warn')
  } else say(network === 'mainnet' ? 'fail' : 'warn', "the minter's signers compared with the operators", 'skipped: no --node given, so a minter with any signers would pass')
  const factory = await read('factory')
  const factoryCode = await client.getCode({ address: factory as Address })
  check(!!factoryCode && factoryCode !== '0x', 'the token factory has code', `no contract at ${factory}`)
}

async function main() {
  const network = pickNetwork()
  const file = process.env.PREFLIGHT_GENESIS || genesisPathFor(network)
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist`)
  const genesis = JSON.parse(fs.readFileSync(file, 'utf8')) as { config: Config; tokens: Record<string, TokenRec> }
  const cfg = genesis.config
  const tokens = Object.values(genesis.tokens ?? {})
  console.log(`preflight: ${network}, ${file}\n`)

  const problems = configProblems(cfg)
  check(problems.length === 0, 'the config is one a node will run', problems.join('; '))
  check(cfg.feed === 'xrpl', 'the feed is the real ledger', `feed is ${cfg.feed}`)
  check(!cfg.testHooks, 'test hooks are off', 'testHooks lets anyone fake an EVM burn', network === 'mainnet' ? 'fail' : 'warn')
  check((cfg.admins ?? []).length > 0, 'an operator key is configured', 'nobody can set a cap, pause or fix a name (ADMIN_KEYS)', network === 'mainnet' ? 'fail' : 'warn')
  check(!!cfg.params.payout?.treasuryAccount, 'a treasury account is named', "its share of the fees stays in the funding account", 'warn')
  check(cfg.xrpl.network === (network === 'mainnet' ? 'mainnet' : 'test'), "the config knows which kind of network it is on (X-addresses)", `xrpl.network is ${cfg.xrpl.network}`, 'warn')
  const noLogo = tokens.filter((t) => !t.native && !t.image)
  if (noLogo.length) say('warn', `${noLogo.length} listed tokens have no logo`, `${noLogo.map((t) => t.ticker ?? t.sym).join(', ')} (an operator can add one: admin meta)`)
  const open = tokens.filter((t) => !t.native && t.capUnits !== undefined && t.capUnits !== '0')
  say('ok', `${tokens.length} tokens in the genesis`, `${open.length} with a cap above zero`)

  // On mainnet the comparisons against the running cluster are the point of the gate; without them any SignerList and any minter would pass.
  check(network !== 'mainnet' || !!flag('node'), 'a node was given to compare against (--node)', 'the SignerLists and the minter cannot be checked against the operators without it')
  const ops = await operatorsFrom(flag('node'))
  if (ops) {
    check(ops.k === cfg.k && ops.n === cfg.n, "the running cluster's k and n match the genesis", `cluster ${ops.k}/${ops.n}, genesis ${cfg.k}/${cfg.n}`)
    check(ops.signers.length === ops.n, 'every operator has published its keys', `${ops.signers.length} of ${ops.n}`)
  }
  // The code: the loader is what makes a running cluster changeable (docs/BRIDGE_UPGRADES.md), so the gate looks at it.
  const code = await codeFrom(flag('node'))
  if (flag('node')) {
    if (!code) say(network === 'mainnet' ? 'fail' : 'warn', 'the cluster answers a code read', 'it does not: it is not running the loader, so its code can never be changed')
    else {
      check(code.loaded === 'app' && !code.error, 'the cluster runs the app it was given', `loaded ${code.loaded}: ${code.error ?? 'no error given'}`)
      check(code.upgraders.length > 0, 'an upgrader key is set', 'with none the code can never be changed (UPGRADE_KEYS at build time)', network === 'mainnet' ? 'fail' : 'warn')
      check(code.hash === code.appHash, "the code on disk is the version the loader recorded", `recorded ${code.hash?.slice(0, 12)}, on disk ${code.appHash?.slice(0, 12)}`)
      say('ok', `code version ${code.version}`, `app ${code.appHash?.slice(0, 12)}, ${code.upgraders.length} upgrader key(s)`)
    }
  }
  await xrplSide(cfg, tokens, ops, network)
  // A cluster that booted XRPL-only has a plan in its genesis and is given its minter by `admin evm`: the running node is where that is named.
  await evmSide(cfg.evm ?? (cfg.evmPlan && ops?.minter ? { ...cfg.evmPlan, minter: ops.minter } : undefined), cfg, ops, network)

  console.log(`\n${fails} failed, ${warns} to look at`)
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error('ERROR', e?.message ?? e)
  process.exit(1)
})
