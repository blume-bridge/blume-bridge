/**
 * The bridge watchdog. Runs anywhere off the node boxes: it needs only the front door's WebSockets (the same ones the
 * site uses) and public RPCs for the two chains, never a key, a node's disk or an ssh login. Each pass it asks every
 * node for its status and one healthy node for the cluster's reads (operators, tokens, transfers, actions, evmActions,
 * unmatched), reads both chains' heads, the lock and funding accounts' XRP, the operators' relayer balances and, once a
 * day, the lock account's holding of each token against the ERC-20's total supply. The rules are in
 * watchdog-rules.ts; WATCHDOG.md says what each one means and what to do.
 *
 *   WATCHDOG_NODES=wss://bridge-main.blumefi.com:8443,wss://bridge-main.blumefi.com:8444,... \
 *   WATCHDOG_WEBHOOK=https://discord.com/api/webhooks/... XRPL_NETWORK=mainnet npx tsx scripts/watchdog.ts
 *
 *   --once          one pass and exit (cron); otherwise a pass every WATCHDOG_INTERVAL_SECONDS (default 60)
 *   --dry-run       read everything, print what would be sent, send nothing and keep no state
 *   --test-alert    send one test message to the webhook (or stdout) and exit
 *   --print-config  show the effective settings (never the webhook) and exit
 *
 * Alerts go to the Discord webhook, or to stdout when WATCHDOG_WEBHOOK is unset, once per condition with a cooldown
 * between reminders and a message when it clears. Nothing secret is read, logged or sent; the webhook URL is
 * scrubbed from every error. State (what is firing, what has been seen) is a small JSON file, WATCHDOG_STATE.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import HotPocket from 'hotpocket-js-client'
import { NETWORKS, pickNetwork } from './network'
import { evmRpc, xrplRpc } from './rpc-util'
import {
  applyDelivered,
  clean,
  configFromEnv,
  emptyState,
  evaluate,
  fromScaled,
  packMessages,
  plan,
  reviveState,
  supplyDue,
  toScaled,
  undeliver,
  type AccountXrp,
  type ActionRead,
  type ClusterReads,
  type EvmActionRead,
  type Message,
  type NodeReading,
  type OperatorsRead,
  type Pool,
  type Post,
  type Snapshot,
  type StatusRead,
  type SupplyRow,
  type TokenRead,
  type TransferRead,
  type UnmatchedRead,
  type WatchConfig,
  type WatchState,
} from './watchdog-rules'

HotPocket.setLogLevel(2)

// ------------------------------------------------------------------ small pure helpers (tested)

export interface NodeSpec {
  index: number
  url: string
  /** host:port, for messages. */
  label: string
}

/** WATCHDOG_NODES: wss://host:port or host:port, comma separated, in the order the cluster is numbered. */
export function parseNodes(raw: string | undefined): NodeSpec[] {
  const parts = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) throw new Error('WATCHDOG_NODES is empty: list the front door endpoints, e.g. wss://bridge-main.blumefi.com:8443,wss://bridge-main.blumefi.com:8444')
  const seen = new Set<string>()
  return parts.map((p, i) => {
    const withScheme = /^[a-z]+:\/\//i.test(p) ? p : `wss://${p}`
    let u: URL
    try {
      u = new URL(withScheme)
    } catch {
      throw new Error(`WATCHDOG_NODES entry ${i + 1} is not a host:port or a wss:// URL`)
    }
    if (u.protocol !== 'wss:') throw new Error(`WATCHDOG_NODES entry ${i + 1} must be wss:// (the front door is TLS), got ${u.protocol}`)
    if (u.username || u.password) throw new Error(`WATCHDOG_NODES entry ${i + 1} carries credentials; the front door needs none`)
    if (!u.port) throw new Error(`WATCHDOG_NODES entry ${i + 1} has no port`)
    const url = `wss://${u.host}`
    if (seen.has(url)) throw new Error(`WATCHDOG_NODES lists ${u.host} twice`)
    seen.add(url)
    return { index: i + 1, url, label: `node ${i + 1} (${u.host})` }
  })
}

/** Removes every secret from a piece of text before it is logged or sent. */
export function scrub(text: string, secrets: (string | undefined)[]): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join('<hidden>')
  return out.replace(/https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '<hidden webhook>')
}

/** balance and reserves from account_info and server_info, in XRP. */
export function accountXrp(account: string, balanceDrops: string, ownerCount: number, reserveBaseXrp: number, reserveIncXrp: number): AccountXrp {
  const balanceXrp = Number(balanceDrops) / 1e6
  const reserveXrp = reserveBaseXrp + reserveIncXrp * ownerCount
  return { account, balanceXrp, reserveXrp, freeXrp: balanceXrp - reserveXrp }
}

/** A hex quantity of wei (or any 18-decimal token units) as a decimal string. */
export function weiToDecimal(hex: string): string {
  return fromScaled(BigInt(hex))
}

export function defaultEvmRpc(chainId: number | null | undefined): string[] {
  if (chainId === 1440000) return ['https://rpc.xrplevm.org']
  if (chainId === 1449000) return ['https://rpc.testnet.xrplevm.org']
  return []
}

/** A webhook must be https; anything else is a typo that would send alerts nowhere or in the clear. */
export function checkWebhook(raw: string | undefined): string | undefined {
  const url = raw?.trim()
  if (!url) return undefined
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('WATCHDOG_WEBHOOK is not a URL')
  }
  if (u.protocol !== 'https:') throw new Error('WATCHDOG_WEBHOOK must be an https URL')
  return url
}

// ------------------------------------------------------------------ delivery (tested with a fake fetch)

export interface DeliverIO {
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
  /** Where messages go when there is no webhook. */
  print(text: string): void
  log(line: string): void
}

/**
 * Sends each post to the webhook, or prints it when there is none. A 429 is waited out once when the wait is short; any
 * other failure leaves the post's messages undelivered, to be raised again next pass. allowed_mentions is empty on
 * purpose: nothing in an alert may ping anybody, whatever a token or a memo says.
 */
export async function deliver(posts: Post[], webhook: string | undefined, io: DeliverIO): Promise<{ delivered: Message[]; failed: Message[] }> {
  const delivered: Message[] = []
  const failed: Message[] = []
  for (const post of posts) {
    if (!webhook) {
      io.print(post.text)
      delivered.push(...post.messages)
      continue
    }
    let ok = false
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const res = await io.fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: post.text, username: 'Blume bridge watchdog', allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15_000) })
        if (res.status === 429) {
          const wait = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 2)
          if (attempt === 0 && wait <= 10) {
            await io.sleep(Math.ceil(wait * 1000) + 250)
            continue
          }
          io.log(`webhook: rate limited (retry after ${wait}s); will try again next pass`)
          break
        }
        if (res.status >= 200 && res.status < 300) ok = true
        else {
          io.log(`webhook: HTTP ${res.status}; will try again next pass`)
          break
        }
      } catch (e) {
        io.log(`webhook: ${scrub((e as Error).message, [webhook])}; will try again next pass`)
        break
      }
    }
    ;(ok ? delivered : failed).push(...post.messages)
  }
  return { delivered, failed }
}

// ------------------------------------------------------------------ one pass (tested with fakes)

export interface PassDeps {
  collect(state: WatchState, now: number): Promise<Snapshot>
  load(): WatchState
  save(state: WatchState): void
  deliver(posts: Post[]): Promise<{ delivered: Message[]; failed: Message[] }>
  now(): number
  log(line: string): void
  heartbeat?(): Promise<void>
}

export interface PassResult {
  findings: number
  sent: number
  failed: number
  active: number
}

export async function runPass(deps: PassDeps, cfg: WatchConfig, opts: { dryRun: boolean }): Promise<PassResult> {
  const state = deps.load()
  const now = deps.now()
  const snap = await deps.collect(state, now)
  const ev = evaluate(snap, state, cfg)
  const pl = plan(ev, state.active, cfg, now)
  const { delivered, failed } = await deps.deliver(packMessages(pl.messages))
  const maxLcl = Math.max(0, ...snap.nodes.map((n) => n.lcl ?? 0))
  const cursor = Math.max(0, ...snap.nodes.map((n) => n.status?.cursor ?? 0))
  const lag = snap.chains.xrplHead !== null && cursor ? snap.chains.xrplHead - cursor : null
  const summary = `nodes ${snap.nodes.filter((n) => n.ok).length}/${snap.nodes.length} lcl ${maxLcl || '-'} xrpl lag ${lag ?? '?'} findings ${ev.findings.length} active ${Object.keys(pl.active).length} sent ${delivered.length} failed ${failed.length}`
  if (opts.dryRun) {
    deps.log(`[dry-run] ${summary}; nothing sent for real, no state kept`)
    return { findings: ev.findings.length, sent: 0, failed: 0, active: Object.keys(pl.active).length }
  }
  const next: WatchState = applyDelivered({ ...ev.state, active: undeliver(pl.active, state.active, failed) }, delivered)
  deps.save(next)
  deps.log(summary)
  if (!failed.length && deps.heartbeat) await deps.heartbeat().catch(() => deps.log('heartbeat: failed'))
  return { findings: ev.findings.length, sent: delivered.length, failed: failed.length, active: Object.keys(next.active).length }
}

// ------------------------------------------------------------------ state file

export function loadStateFile(file: string, log: (l: string) => void): WatchState {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return emptyState()
  }
  try {
    return reviveState(JSON.parse(text))
  } catch {
    log(`state file ${file} is not valid JSON; starting fresh (nothing already firing is lost, but it may be announced again)`)
    return emptyState()
  }
}

export function saveStateFile(file: string, state: WatchState): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

// ------------------------------------------------------------------ reading the world (not unit tested: it is the network)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

interface Hp {
  client: any
  close(): Promise<void>
}
async function connect(spec: NodeSpec, keys: unknown, timeoutMs: number): Promise<Hp> {
  const client = await withTimeout<any>(HotPocket.createClient([spec.url], keys), timeoutMs, 'create client')
  const close = async () => {
    try {
      await withTimeout(client.close(), 3000, 'close')
    } catch {
      /* gone already */
    }
  }
  let connected = false
  try {
    connected = await withTimeout<boolean>(client.connect(), timeoutMs, 'connect')
  } catch (e) {
    await close()
    throw e
  }
  if (!connected) {
    await close()
    throw new Error('could not connect')
  }
  return { client, close }
}

let readSeq = 0
async function readOne(hp: Hp, type: string, timeoutMs: number): Promise<any> {
  // hotpocket-js-client keys its answers by id and defaults to the millisecond: two reads in one tick would swap answers.
  const id = `wd-${process.pid}-${++readSeq}`
  const reply = await hp.client.submitContractReadRequest(JSON.stringify({ type, id }), id, timeoutMs)
  if (!reply || typeof reply !== 'object') throw new Error(`${type}: no answer`)
  if (reply.type === 'error') throw new Error(`${type}: ${clean(reply.error, 80)}`)
  if (reply.type !== type) throw new Error(`${type}: an answer of another type came back`)
  return reply
}

async function readNode(spec: NodeSpec, keys: unknown, timeoutMs: number): Promise<NodeReading> {
  const base = { index: spec.index, label: spec.label }
  let hp: Hp | null = null
  try {
    hp = await connect(spec, keys, timeoutMs)
    const [stat, status] = await Promise.all([withTimeout<any>(hp.client.getStatus(), timeoutMs, 'status'), readOne(hp, 'status', timeoutMs)])
    return { ...base, ok: true, lcl: typeof stat?.ledgerSeqNo === 'number' ? stat.ledgerSeqNo : undefined, voteStatus: typeof stat?.voteStatus === 'string' ? stat.voteStatus : undefined, status: status as StatusRead }
  } catch (e) {
    return { ...base, ok: false, error: (e as Error).message }
  } finally {
    await hp?.close()
  }
}

async function readClusterFrom(spec: NodeSpec, keys: unknown, timeoutMs: number): Promise<ClusterReads> {
  const out: ClusterReads = { from: spec.index, operators: null, tokens: null, transfers: null, actions: null, evmActions: null, unmatched: null }
  let hp: Hp | null = null
  try {
    hp = await connect(spec, keys, timeoutMs)
    const attempt = async <T>(type: string, pick: (r: any) => T): Promise<T | null> => {
      try {
        return pick(await readOne(hp!, type, timeoutMs))
      } catch {
        return null
      }
    }
    out.operators = await attempt<OperatorsRead>('operators', (r) => r)
    out.tokens = await attempt<TokenRead[]>('tokens', (r) => r.tokens)
    out.transfers = await attempt<TransferRead[]>('transfers', (r) => r.transfers)
    out.actions = await attempt<ActionRead[]>('actions', (r) => r.actions)
    out.evmActions = await attempt<EvmActionRead[]>('evmActions', (r) => r.actions)
    out.unmatched = await attempt<UnmatchedRead[]>('unmatched', (r) => r.unmatched)
  } catch {
    /* all null: the pass reports reads failing */
  } finally {
    await hp?.close()
  }
  return out
}

const TOTAL_SUPPLY = '0x18160ddd'

export interface CollectorOptions {
  nodes: NodeSpec[]
  networkName: keyof typeof NETWORKS
  xrplRpc: string[]
  evmRpcOverride: string[]
  cfg: WatchConfig
  secrets: (string | undefined)[]
  /** How the nodes are asked. Defaults to the HotPocket client; tests put fakes here. */
  hp?: { readNode(spec: NodeSpec): Promise<NodeReading>; readCluster(spec: NodeSpec): Promise<ClusterReads> }
  sleep?: (ms: number) => Promise<void>
  /** Seconds a node, and a public RPC, get to answer. */
  nodeTimeoutS?: number
  rpcTimeoutS?: number
}

export function makeCollector(opts: CollectorOptions): PassDeps['collect'] {
  const NODE_MS = (opts.nodeTimeoutS ?? 15) * 1000
  const RPC_MS = (opts.rpcTimeoutS ?? 10) * 1000
  let keys: unknown
  const ensureKeys = async () => (keys ??= await HotPocket.generateKeys())
  const hp = opts.hp ?? { readNode: async (spec: NodeSpec) => readNode(spec, await ensureKeys(), NODE_MS), readCluster: async (spec: NodeSpec) => readClusterFrom(spec, await ensureKeys(), NODE_MS) }
  const wait = opts.sleep ?? sleep
  let round = 0
  return async (state, now) => {
    round++
    const blind: string[] = []
    const nodes = await Promise.all(opts.nodes.map((n) => hp.readNode(n)))

    // Reads that every node serves alike come from one healthy node, a different one each pass.
    const healthy = nodes.filter((n) => n.ok)
    let reads: ClusterReads | null = null
    if (healthy.length) {
      const pick = healthy[round % healthy.length]
      reads = await hp.readCluster(opts.nodes[pick.index - 1])
    }
    const operators = reads?.operators ?? null

    // XRP Ledger: the head, the reserves, the two accounts.
    let xrplHead: number | null = null
    let accounts: Snapshot['accounts'] = null
    try {
      const info = await xrplRpc(opts.xrplRpc, 'server_info', {}, RPC_MS)
      const v = info.info?.validated_ledger
      xrplHead = Number(v?.seq) || null
      const base = Number(v?.reserve_base_xrp)
      const inc = Number(v?.reserve_inc_xrp)
      if (xrplHead === null || !Number.isFinite(base) || !Number.isFinite(inc)) throw new Error('server_info carried no validated ledger or reserves')
      if (operators?.lockAccount && operators?.fundingAccount) {
        accounts = { lock: null, funding: null }
        for (const [role, address] of [['lock', operators.lockAccount], ['funding', operators.fundingAccount]] as const) {
          try {
            const r = await xrplRpc(opts.xrplRpc, 'account_info', { account: address, ledger_index: 'validated' }, RPC_MS)
            accounts[role] = accountXrp(address, String(r.account_data.Balance), Number(r.account_data.OwnerCount ?? 0), base, inc)
          } catch (e) {
            const m = (e as Error).message
            blind.push(/actNotFound/.test(m) ? `${role} account ${address} does not exist on ${NETWORKS[opts.networkName].label}: is XRPL_NETWORK=${opts.networkName} right?` : `${role} account balance: ${clean(m, 100)}`)
          }
        }
      }
    } catch (e) {
      blind.push(`XRP Ledger head and reserves: ${clean((e as Error).message, 140)}`)
    }

    // XRPL EVM: the head, the relayers' gas.
    const chainId = operators?.evmChainId ?? healthy.map((n) => n.status?.evm?.chainId).find((x): x is number => typeof x === 'number') ?? null
    const evmUrls = opts.evmRpcOverride.length ? opts.evmRpcOverride : defaultEvmRpc(chainId)
    let evmHead: number | null = null
    let relayers: Snapshot['relayers'] = null
    if (chainId !== null) {
      if (!evmUrls.length) blind.push(`no EVM RPC for chain ${chainId}: set WATCHDOG_EVM_RPC`)
      else {
        try {
          evmHead = Number(BigInt(await evmRpc(evmUrls, 'eth_blockNumber', [], RPC_MS)))
        } catch (e) {
          blind.push(`XRPL EVM head: ${clean((e as Error).message, 140)}`)
        }
        const signers = operators?.signers?.filter((s) => s.evmAddress) ?? []
        if (signers.length) {
          try {
            relayers = []
            for (const s of signers) {
              const wei = BigInt(await evmRpc(evmUrls, 'eth_getBalance', [s.evmAddress, 'latest'], RPC_MS))
              relayers.push({ address: s.evmAddress!, node: s.node, balanceXrp: Number(fromScaled(wei)) })
              await wait(150)
            }
          } catch (e) {
            relayers = null
            blind.push(`relayer balances: ${clean((e as Error).message, 140)}`)
          }
        }
      }
    }

    // Pools for tokens the watchdog has not seen before, so the alert can suggest a cap.
    const pools: Snapshot['pools'] = {}
    if (reads?.tokens && state.baselined.tokens) {
      for (const t of reads.tokens.filter((x) => !state.seen.tokens.includes(x.sym) && !x.native && x.currency && x.issuer)) {
        try {
          const r = await xrplRpc(opts.xrplRpc, 'amm_info', { asset: { currency: 'XRP' }, asset2: { currency: t.currency, issuer: t.issuer }, ledger_index: 'validated' }, RPC_MS)
          const xrpSide = typeof r.amm.amount === 'string' ? r.amm.amount : r.amm.amount2
          const tokenSide = typeof r.amm.amount === 'string' ? r.amm.amount2 : r.amm.amount
          pools[t.sym] = { xrp: fromScaled(BigInt(xrpSide) * 10n ** 12n), tokens: String(tokenSide.value) } satisfies Pool
        } catch (e) {
          pools[t.sym] = /actNotFound|entryNotFound|objectNotFound|ammNotFound/.test((e as Error).message) ? null : undefined
        }
      }
    }

    // Once a day: does the lock account hold at least what is minted?
    let supply: SupplyRow[] | null = null
    const due = supplyDue(state, now, opts.cfg)
    if (due.due && reads?.tokens && operators?.lockAccount && evmUrls.length) {
      const only = due.onlyActive ? new Set(Object.keys(state.active).filter((k) => k.startsWith('supply-short:')).map((k) => k.slice('supply-short:'.length))) : null
      supply = []
      for (const t of reads.tokens.filter((x) => x.evmAddress && (!only || only.has(x.sym)))) {
        const read = async (): Promise<SupplyRow> => {
          try {
            // The supply first: a mint that lands between the two reads can only make the holding look bigger.
            const total = weiToDecimal(await evmRpc(evmUrls, 'eth_call', [{ to: t.evmAddress, data: TOTAL_SUPPLY }, 'latest'], RPC_MS))
            let holding: string
            if (t.native) holding = (accounts?.lock?.freeXrp ?? 0).toFixed(6)
            else {
              const r = await xrplRpc(opts.xrplRpc, 'account_lines', { account: operators.lockAccount, peer: t.issuer, ledger_index: 'validated', limit: 400 }, RPC_MS)
              const line = (r.lines as { currency: string; balance: string }[]).find((l) => l.currency === t.currency)
              holding = line ? String(line.balance).replace(/^-/, '') : '0'
            }
            return { sym: t.sym, holding, supply: total }
          } catch (e) {
            return { sym: t.sym, error: clean((e as Error).message, 100) }
          }
        }
        let row = await read()
        // The two reads are not one instant (a burn can leave the supply before the release leaves the account): look again before crying.
        const h = toScaled(row.holding)
        const s = toScaled(row.supply)
        if (h !== null && s !== null && h < s) {
          await wait(15_000)
          row = await read()
        }
        if (row.error) blind.push(`supply check ${t.sym}: ${row.error}`)
        supply.push(row)
        await wait(150)
      }
    }

    const snap: Snapshot = { at: now, nodes, reads, chains: { xrplHead, evmHead }, accounts, relayers, pools, supply, blind: blind.map((b) => scrub(b, opts.secrets)) }
    return snap
  }
}

// ------------------------------------------------------------------ the program

function printConfig(env: Record<string, string | undefined>, cfg: WatchConfig, nodes: NodeSpec[], network: string, xrplRpc: string[], evmRpc: string[]): void {
  console.log(`nodes (${nodes.length}): ${nodes.map((n) => n.label).join(', ')}`)
  console.log(`XRP Ledger network ${network}; RPC ${xrplRpc.map((u) => new URL(u).host).join(', ')}`)
  console.log(`EVM RPC ${evmRpc.length ? evmRpc.map((u) => new URL(u).host).join(', ') : '(by chain id, once the cluster says which)'}`)
  console.log(`webhook ${env.WATCHDOG_WEBHOOK?.trim() ? 'set' : 'unset (alerts go to stdout)'}; heartbeat ${env.WATCHDOG_HEARTBEAT_URL?.trim() ? 'set' : 'unset'}`)
  console.log(`state file ${env.WATCHDOG_STATE ?? './watchdog-state.json'}; interval ${env.WATCHDOG_INTERVAL_SECONDS ?? '60'}s`)
  console.log(JSON.stringify(cfg, null, 2))
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const flags = new Set(argv)
  const known = new Set(['--once', '--dry-run', '--test-alert', '--print-config', '--help'])
  for (const a of flags) if (!known.has(a)) throw new Error(`unknown argument ${a}: expected ${[...known].join(', ')}`)
  if (flags.has('--help')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*\n/, '').replace(/^ \* ?/gm, ''))
    return 0
  }
  const cfg = configFromEnv(env)
  const webhook = checkWebhook(env.WATCHDOG_WEBHOOK)
  const heartbeat = env.WATCHDOG_HEARTBEAT_URL?.trim() || undefined
  if (heartbeat && !/^https:\/\//.test(heartbeat)) throw new Error('WATCHDOG_HEARTBEAT_URL must be an https URL')
  const secrets = [webhook, heartbeat]
  const log = (line: string) => console.log(`${new Date().toISOString()} ${scrub(line, secrets)}`)
  const io: DeliverIO = { fetch, sleep, print: (t) => console.log(`\n${scrub(t, secrets)}\n`), log }

  if (flags.has('--test-alert')) {
    const test: Message = { key: 'test', kind: 'alert', severity: 'info', title: `Watchdog test alert from ${os.hostname()}`, lines: [`sent ${new Date().toISOString()}; if you can read this, alerts reach this channel`] }
    const r = await deliver(packMessages([test]), webhook, io)
    if (r.failed.length) {
      console.error('the test alert was NOT delivered')
      return 1
    }
    log(webhook ? 'test alert delivered' : 'test alert printed (WATCHDOG_WEBHOOK is unset)')
    return 0
  }

  const networkName = pickNetwork(env.XRPL_NETWORK)
  const xrplRpc = env.WATCHDOG_XRPL_RPC?.trim() ? env.WATCHDOG_XRPL_RPC.split(',').map((s) => s.trim()).filter(Boolean) : NETWORKS[networkName].rpc
  const evmRpcOverride = (env.WATCHDOG_EVM_RPC ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const nodes = parseNodes(env.WATCHDOG_NODES)
  if (flags.has('--print-config')) {
    printConfig(env, cfg, nodes, networkName, xrplRpc, evmRpcOverride)
    return 0
  }

  const stateFile = env.WATCHDOG_STATE?.trim() || './watchdog-state.json'
  const intervalS = Number(env.WATCHDOG_INTERVAL_SECONDS ?? 60)
  if (!Number.isFinite(intervalS) || intervalS < 10) throw new Error('WATCHDOG_INTERVAL_SECONDS must be at least 10')
  const dryRun = flags.has('--dry-run')
  const seconds = (name: string, fallback: number) => {
    const v = Number(env[name] ?? fallback)
    if (!Number.isFinite(v) || v < 1 || v > 120) throw new Error(`${name} must be from 1 to 120 seconds`)
    return v
  }
  const collect = makeCollector({ nodes, networkName, xrplRpc, evmRpcOverride, cfg, secrets, nodeTimeoutS: seconds('WATCHDOG_NODE_TIMEOUT_SECONDS', 15), rpcTimeoutS: seconds('WATCHDOG_RPC_TIMEOUT_SECONDS', 10) })
  const deps: PassDeps = {
    collect,
    load: () => loadStateFile(stateFile, log),
    save: (s) => saveStateFile(stateFile, s),
    deliver: (posts) => (dryRun ? deliverDry(posts, io) : deliver(posts, webhook, io)),
    now: () => Date.now(),
    log,
    heartbeat: heartbeat ? async () => void (await fetch(heartbeat, { signal: AbortSignal.timeout(10_000) })) : undefined,
  }

  const once = flags.has('--once') || dryRun
  let stop = false
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stop = true))
  let exit = 0
  do {
    try {
      await runPass(deps, cfg, { dryRun })
    } catch (e) {
      exit = 1
      log(`pass failed: ${scrub((e as Error).message, secrets)}`)
    }
    if (once) break
    for (let waited = 0; waited < intervalS * 1000 && !stop; waited += 500) await sleep(500)
  } while (!stop)
  return exit
}

/** --dry-run: show what would be sent, deliver nothing, and count it all as delivered so the printout is the whole story. */
async function deliverDry(posts: Post[], io: DeliverIO): Promise<{ delivered: Message[]; failed: Message[] }> {
  for (const p of posts) io.print(`[dry-run] would send:\n${p.text}`)
  if (!posts.length) io.log('[dry-run] nothing to send')
  return { delivered: posts.flatMap((p) => p.messages), failed: [] }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error('ERROR', (e as Error).message)
      process.exit(1)
    },
  )
}
