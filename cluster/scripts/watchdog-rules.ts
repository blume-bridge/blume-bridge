/**
 * The watchdog's rules, with no network and no clock of their own: a snapshot of what one pass read goes in, findings
 * and the new state come out. scripts/watchdog.ts reads the cluster and the two chains and delivers the messages; the
 * rules live here so every condition can be tested with a made-up snapshot.
 *
 * The cluster's reads are taken as they come (status, operators, tokens, transfers, actions, evmActions, unmatched), with
 * every field optional: other work changes their shapes, and a field that is missing means "cannot tell", never "fine".
 * A condition that cannot be judged this pass is left alone: it neither fires nor recovers. Nothing here handles a secret.
 */

export type Severity = 'critical' | 'warn' | 'info'
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warn: 1, info: 2 }

// ------------------------------------------------------------------ configuration

export interface WatchConfig {
  lclStallSeconds: number
  hashMismatchPolls: number
  contestedPolls: number
  nullPolls: number
  unreachablePolls: number
  rpcDownPolls: number
  xrplLagLedgers: number
  evmLagBlocks: number
  actionPendingMinutes: number
  awaitingFeeMinutes: number
  freeXrpWarn: number
  freeXrpCritical: number
  relayerMinXrp: number
  suggestCapXrp: number
  minPoolXrp: number
  supplyEveryHours: number
  /** Relative: a lock holding may be this fraction short of the supply before it counts (IOU arithmetic rounds). */
  supplyTolerance: string
  cooldownMinutes: number
  cooldownsByKind: Record<string, number>
  ignoreFailed: string[]
}

export const DEFAULT_CONFIG: WatchConfig = {
  lclStallSeconds: 120,
  hashMismatchPolls: 2,
  contestedPolls: 2,
  nullPolls: 3,
  unreachablePolls: 2,
  rpcDownPolls: 3,
  xrplLagLedgers: 100,
  evmLagBlocks: 200,
  actionPendingMinutes: 30,
  awaitingFeeMinutes: 5,
  freeXrpWarn: 10,
  freeXrpCritical: 3,
  relayerMinXrp: 1,
  suggestCapXrp: 1000,
  minPoolXrp: 1000,
  supplyEveryHours: 24,
  supplyTolerance: '0.000000001',
  cooldownMinutes: 60,
  cooldownsByKind: {},
  ignoreFailed: ['expired'],
}

const NUMERIC: Record<string, keyof WatchConfig> = {
  WATCHDOG_LCL_STALL_SECONDS: 'lclStallSeconds',
  WATCHDOG_HASH_POLLS: 'hashMismatchPolls',
  WATCHDOG_CONTESTED_POLLS: 'contestedPolls',
  WATCHDOG_NULL_POLLS: 'nullPolls',
  WATCHDOG_UNREACHABLE_POLLS: 'unreachablePolls',
  WATCHDOG_RPC_DOWN_POLLS: 'rpcDownPolls',
  WATCHDOG_XRPL_LAG_LEDGERS: 'xrplLagLedgers',
  WATCHDOG_EVM_LAG_BLOCKS: 'evmLagBlocks',
  WATCHDOG_ACTION_MINUTES: 'actionPendingMinutes',
  WATCHDOG_AWAITING_FEE_MINUTES: 'awaitingFeeMinutes',
  WATCHDOG_FREE_XRP_WARN: 'freeXrpWarn',
  WATCHDOG_FREE_XRP_CRIT: 'freeXrpCritical',
  WATCHDOG_RELAYER_MIN_XRP: 'relayerMinXrp',
  WATCHDOG_SUGGEST_CAP_XRP: 'suggestCapXrp',
  WATCHDOG_MIN_POOL_XRP: 'minPoolXrp',
  WATCHDOG_SUPPLY_EVERY_HOURS: 'supplyEveryHours',
  WATCHDOG_COOLDOWN_MINUTES: 'cooldownMinutes',
}

/** Thresholds from the environment, every one validated: a typo must stop the watchdog, not quietly switch a rule off. */
export function configFromEnv(env: Record<string, string | undefined>): WatchConfig {
  const cfg: WatchConfig = { ...DEFAULT_CONFIG, cooldownsByKind: {}, ignoreFailed: [...DEFAULT_CONFIG.ignoreFailed] }
  for (const [name, field] of Object.entries(NUMERIC)) {
    const raw = env[name]?.trim()
    if (!raw) continue
    const v = Number(raw)
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number, got '${raw}'`)
    ;(cfg as unknown as Record<string, number>)[field] = v
  }
  const tol = env.WATCHDOG_SUPPLY_TOLERANCE?.trim()
  if (tol) {
    if (!/^[0-9]+(\.[0-9]+)?$/.test(tol) || Number(tol) >= 0.1) throw new Error(`WATCHDOG_SUPPLY_TOLERANCE must be a small decimal fraction like 0.000000001, got '${tol}'`)
    cfg.supplyTolerance = tol
  }
  const cooldowns = env.WATCHDOG_COOLDOWNS?.trim()
  if (cooldowns) {
    for (const part of cooldowns.split(',')) {
      const [kind, minutes] = part.split('=').map((s) => s.trim())
      const v = Number(minutes)
      if (!kind || !Number.isFinite(v) || v <= 0) throw new Error(`WATCHDOG_COOLDOWNS entries look like kind=minutes, got '${part}'`)
      cfg.cooldownsByKind[kind] = v
    }
  }
  if (env.WATCHDOG_IGNORE_FAILED !== undefined) cfg.ignoreFailed = env.WATCHDOG_IGNORE_FAILED.split(',').map((s) => s.trim()).filter(Boolean)
  if (cfg.freeXrpCritical > cfg.freeXrpWarn) throw new Error('WATCHDOG_FREE_XRP_CRIT must not be above WATCHDOG_FREE_XRP_WARN')
  return cfg
}

// ------------------------------------------------------------------ what one pass reads

export interface StatusRead {
  node?: string
  k?: number
  n?: number
  cursor?: number
  evmCursor?: number | null
  stateHash?: string
  counts?: Record<string, number>
  evm?: { minter?: string; chainId?: number } | null
  paused?: boolean
  lastRound?: {
    lcl?: number
    heard?: string
    timedOut?: boolean
    myView?: string | null
    counts?: Record<string, number>
    winner?: string | null
    evmWinner?: string | null
  } | null
}

export interface NodeReading {
  /** Position in WATCHDOG_NODES, from 1. */
  index: number
  /** Where it was asked, host:port: public, no credentials. */
  label: string
  ok: boolean
  error?: string
  /** HotPocket's own last closed ledger for this node. */
  lcl?: number
  voteStatus?: string
  status?: StatusRead
}

export interface OperatorsRead {
  k?: number
  n?: number
  ready?: boolean
  lockAccount?: string
  fundingAccount?: string
  minter?: string | null
  evmChainId?: number | null
  paused?: boolean
  signers?: { node?: string; xrplAddress?: string; evmAddress?: string }[]
}
export interface TokenRead {
  sym: string
  ticker?: string
  name?: string
  issuer?: string
  currency?: string
  native?: boolean
  status?: string
  lane?: string
  capUnits?: number | string
  lockedUnits?: number | string
  evmAddress?: string
  /** Listed to open by itself (the cluster's opensByItself): no limit once its ERC-20 lands. */
  autoOpen?: boolean
}
export interface TransferRead {
  id: string
  dir?: string
  sym?: string
  from?: string
  to?: string
  amount?: number | string
  done?: boolean
  failed?: string
  held?: { result?: string; since?: number; until?: number; attempts?: number; returning?: boolean }
  awaitingFee?: { feeTo?: string; feeMemo?: string; feeXrp?: string | number; returnMemo?: string; returnFeeXrp?: string | number }
  createdAt?: number
  updatedAt?: number
}
export interface ActionRead {
  id: string
  kind?: string
  account?: string
  status?: string
  attempts?: number
  createdAt?: number
  updatedAt?: number
}
export interface EvmActionRead {
  id: string
  kind?: string
  status?: string
  attempts?: number
  createdAt?: number
  updatedAt?: number
}
export interface UnmatchedRead {
  tx: string
  ledger?: number
  from?: string
  to?: string
  amount?: { currency?: string; value?: string }
  memo?: string | null
  reason?: string
}

/** Reads taken from one node (the contract serves the same state from every node). null: that read failed. */
export interface ClusterReads {
  from: number
  operators: OperatorsRead | null
  tokens: TokenRead[] | null
  transfers: TransferRead[] | null
  actions: ActionRead[] | null
  evmActions: EvmActionRead[] | null
  unmatched: UnmatchedRead[] | null
}

export interface AccountXrp {
  account: string
  balanceXrp: number
  reserveXrp: number
  /** balance - reserve: what can still be spent. */
  freeXrp: number
}
export interface Pool {
  xrp: string
  tokens: string
}
export interface SupplyRow {
  sym: string
  /** What the lock account holds on the ledger, a decimal string. */
  holding?: string
  /** The ERC-20's total supply, a decimal string in token units. */
  supply?: string
  error?: string
}

export interface Snapshot {
  /** Wall clock, ms. */
  at: number
  nodes: NodeReading[]
  /** Null when no node answered. */
  reads: ClusterReads | null
  chains: { xrplHead: number | null; evmHead: number | null }
  accounts: { lock: AccountXrp | null; funding: AccountXrp | null } | null
  relayers: { address: string; node?: string; balanceXrp: number }[] | null
  /** XRP pools for tokens that were not seen before; undefined = not read, null = no pool. */
  pools: Record<string, Pool | null | undefined>
  /** Present only when a supply check was due. */
  supply: SupplyRow[] | null
  /** What the watchdog could not read this pass for reasons of its own (an RPC down, a wrong network): it is blind there. */
  blind: string[]
}

// ------------------------------------------------------------------ state kept between passes

export interface NodeTrack {
  lcl?: number
  lclAt?: number
  unreachable: number
  contested: number
  nullRounds: number
}
export interface ActiveAlert {
  kind: string
  severity: Severity
  title: string
  since: number
  lastSentAt: number
  fingerprint: string
}
export interface WatchState {
  version: 1
  nodes: Record<string, NodeTrack>
  hashPolls: number
  cursors: { xrpl?: { v: number; at: number }; evm?: { v: number; at: number } }
  rpcFails: { xrpl: number; evm: number }
  readFails: number
  blindPolls: number
  baselined: { tokens: boolean; unmatched: boolean; failed: boolean }
  seen: { tokens: string[]; unmatched: string[]; transfersFailed: string[]; actionsFailed: string[]; evmFailed: string[] }
  lastSupplyCheckAt?: number
  active: Record<string, ActiveAlert>
}

export function emptyState(): WatchState {
  return {
    version: 1,
    nodes: {},
    hashPolls: 0,
    cursors: {},
    rpcFails: { xrpl: 0, evm: 0 },
    readFails: 0,
    blindPolls: 0,
    baselined: { tokens: false, unmatched: false, failed: false },
    seen: { tokens: [], unmatched: [], transfersFailed: [], actionsFailed: [], evmFailed: [] },
    active: {},
  }
}

/** A state file from an older or damaged run: keep what parses, start the rest fresh. */
export function reviveState(raw: unknown): WatchState {
  const base = emptyState()
  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 1) return base
  const r = raw as Partial<WatchState>
  return {
    ...base,
    ...r,
    nodes: { ...base.nodes, ...(r.nodes ?? {}) },
    cursors: { ...base.cursors, ...(r.cursors ?? {}) },
    rpcFails: { ...base.rpcFails, ...(r.rpcFails ?? {}) },
    baselined: { ...base.baselined, ...(r.baselined ?? {}) },
    seen: { ...base.seen, ...(r.seen ?? {}) },
    active: { ...(r.active ?? {}) },
  }
}

// ------------------------------------------------------------------ findings

export interface Finding {
  /** The identity of the condition: "lcl-stalled:2". */
  key: string
  /** The family it belongs to, for cooldowns: "lcl-stalled". */
  kind: string
  severity: Severity
  title: string
  lines: string[]
  /** Changes when the set of things the finding is about changes; a change is sent at once, whatever the cooldown. */
  fingerprint?: string
  /** Happened once: sent once, never repeated, no recovery message. */
  event?: boolean
  /** For an event: what to remember once it has really been delivered, so a message that failed to send is raised again. */
  remember?: Remember
}

export type SeenList = keyof WatchState['seen']
export interface Remember {
  list: SeenList
  ids: string[]
}

export interface Evaluation {
  findings: Finding[]
  state: WatchState
  /** Key prefixes that could not be judged this pass: what is active under them stays active, and is not called recovered. */
  skip: string[]
}

// ------------------------------------------------------------------ small helpers

const MAX_SEEN = 600
const short = (s: string | undefined, n = 10) => (s ? (s.length > n + 2 ? `${s.slice(0, n)}..` : s) : '?')
const mins = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`)
const remember = (list: string[], add: string[]) => {
  for (const a of add) if (!list.includes(a)) list.push(a)
  if (list.length > MAX_SEEN) list.splice(0, list.length - MAX_SEEN)
}

/** Control characters and the invisible and direction-changing ones, built from code points so the source stays plain ASCII. */
const UNSAFE_CHARS = new RegExp(
  `[${[[0, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]].map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`,
  'g',
)

/** Text that came off a chain or out of a user's memo, made safe to put in a chat message: one line, no markup, bounded. */
export function clean(s: unknown, max = 48): string {
  const t = String(s ?? '')
    .replace(UNSAFE_CHARS, ' ')
    .replace(/[`*~|>\\]/g, '')
    .replace(/@/g, '(at)')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}~` : t
}

// ------------------------------------------------------------------ decimals (token amounts are strings; no floats)

const SCALE = 18
export function toScaled(s: string | number | undefined | null): bigint | null {
  if (s === undefined || s === null) return null
  // rippled prints small IOU balances with an exponent ("1e-15"), so accept one
  const m = /^([0-9]+)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(String(s).trim())
  if (!m) return null
  const exp = Number(m[3] ?? 0)
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 60) return null
  // digits as one integer scaled by 10^-frac, then shifted by the exponent into the 18-digit scale
  const digits = BigInt(m[1] + (m[2] ?? ''))
  const shift = SCALE + exp - (m[2] ?? '').length
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift)
}
export function fromScaled(v: bigint): string {
  const s = v.toString().padStart(SCALE + 1, '0')
  const whole = s.slice(0, -SCALE)
  const frac = s.slice(-SCALE).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}
/** Keep the first `digits` significant digits and zero the rest (rounding down). */
export function floorSignificant(v: bigint, digits: number): bigint {
  const s = v.toString()
  if (s.length <= digits) return v
  return BigInt(s.slice(0, digits) + '0'.repeat(s.length - digits))
}

/**
 * What cap, in tokens, is `capXrp` of XRP worth at this pool's price, rounded down to 3 significant digits: a number to
 * set by hand, not one to trust. null when the pool is too thin to price from.
 */
export function suggestCap(pool: Pool | null | undefined, capXrp: number, minPoolXrp: number): { cap: string } | { why: string } {
  if (!pool) return { why: 'no XRP pool: price it by hand' }
  const xrp = toScaled(pool.xrp)
  const tokens = toScaled(pool.tokens)
  const cap = toScaled(capXrp)
  const min = toScaled(minPoolXrp)
  if (xrp === null || tokens === null || cap === null || min === null || xrp === 0n || tokens === 0n) return { why: 'the pool could not be read: price it by hand' }
  if (xrp < min) return { why: `the pool holds only ${fromScaled(xrp)} XRP, less than ${minPoolXrp}: too thin to price from, set the cap by hand` }
  const units = (cap * tokens) / xrp
  return { cap: fromScaled(floorSignificant(units, 3)) }
}

// ------------------------------------------------------------------ the rules

export function evaluate(snap: Snapshot, prev: WatchState, cfg: WatchConfig): Evaluation {
  const state: WatchState = structuredClone(prev)
  const findings: Finding[] = []
  const skip: string[] = []
  const now = snap.at
  const add = (f: Finding) => findings.push(f)
  const ok = snap.nodes.filter((n) => n.ok)
  const reads = snap.reads

  // ---- who answers
  for (const n of snap.nodes) {
    const t = (state.nodes[n.index] ??= { unreachable: 0, contested: 0, nullRounds: 0 })
    if (n.ok) t.unreachable = 0
    else t.unreachable++
  }
  if (snap.nodes.length > 0 && ok.length === 0) {
    if (Math.min(...snap.nodes.map((n) => state.nodes[n.index].unreachable)) >= cfg.unreachablePolls) {
      add({ key: 'front-door-down', kind: 'front-door-down', severity: 'critical', title: 'No node answers through the front door', lines: [`none of ${snap.nodes.length} node endpoints answered for ${cfg.unreachablePolls} passes (the front door, nginx or the relay is down, or this machine has no route)`, ...snap.nodes.map((n) => `${n.label}: ${clean(n.error, 90)}`)] })
    }
    skip.push('node-unreachable:', 'lcl-stalled:', 'cluster-halting', 'state-hash', 'cursor-lag:', 'views-', 'transfers-', 'actions-', 'evm-actions-', 'reads-failing')
  } else {
    for (const n of snap.nodes) {
      const t = state.nodes[n.index]
      if (!n.ok && t.unreachable >= cfg.unreachablePolls) add({ key: `node-unreachable:${n.index}`, kind: 'node-unreachable', severity: 'warn', title: `${n.label} does not answer`, lines: [`${t.unreachable} passes in a row: ${clean(n.error, 120)}`] })
      if (!n.ok) skip.push(`lcl-stalled:${n.index}`)
    }
  }

  // ---- last closed ledger
  const stalled = new Set<number>()
  let lclKnown = ok.length > 0
  for (const n of ok) {
    const t = state.nodes[n.index]
    const lcl = n.lcl ?? n.status?.lastRound?.lcl
    if (typeof lcl !== 'number') {
      lclKnown = false
      skip.push(`lcl-stalled:${n.index}`)
      continue
    }
    if (t.lcl !== lcl || t.lclAt === undefined) {
      t.lcl = lcl
      t.lclAt = now
    }
    const stuck = now - (t.lclAt ?? now)
    if (stuck > cfg.lclStallSeconds * 1000) {
      stalled.add(n.index)
      add({ key: `lcl-stalled:${n.index}`, kind: 'lcl-stalled', severity: 'warn', title: `${n.label} has stopped closing ledgers`, lines: [`last closed ledger ${lcl}, unchanged for ${mins(stuck)}${n.voteStatus ? `; vote status ${clean(n.voteStatus, 20)}` : ''}`] })
    }
  }
  const nNodes = reads?.operators?.n ?? ok.map((n) => n.status?.n).find((x): x is number => typeof x === 'number') ?? snap.nodes.length
  if (lclKnown && nNodes > 0) {
    const need = Math.ceil(0.8 * nNodes)
    const healthy = ok.filter((n) => !stalled.has(n.index)).length
    if (healthy < need) add({ key: 'cluster-halting', kind: 'cluster-halting', severity: 'critical', title: `Only ${healthy} of ${nNodes} nodes are closing ledgers`, lines: [`consensus needs ${need} (80%) of ${nNodes}: the cluster has stopped, or is about to. Nodes down or not closing: ${snap.nodes.filter((n) => !n.ok || stalled.has(n.index)).map((n) => n.index).join(', ')}`] })
  } else skip.push('cluster-halting')

  // ---- state hashes
  const hashed = ok.filter((n) => typeof n.status?.stateHash === 'string')
  if (hashed.length >= 2) {
    const groups = new Map<string, number[]>()
    for (const n of hashed) groups.set(n.status!.stateHash!, [...(groups.get(n.status!.stateHash!) ?? []), n.index])
    if (groups.size > 1) state.hashPolls++
    else state.hashPolls = 0
    if (state.hashPolls >= cfg.hashMismatchPolls) {
      const lines = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([h, idx]) => `node ${idx.join(', ')}: state ${h.slice(0, 12)}`)
      add({ key: 'state-hash', kind: 'state-hash', severity: 'critical', title: 'The nodes disagree about the state', lines: [`${state.hashPolls} passes in a row`, ...lines], fingerprint: [...groups.keys()].sort().join(',') })
    }
  } else skip.push('state-hash')

  // ---- cursors against the chains' heads
  const cursorRule = (name: 'xrpl' | 'evm', cursor: number | undefined, head: number | null, window: number, unit: string) => {
    const key = `cursor-lag:${name}`
    if (cursor === undefined) return skip.push(key)
    const tracked = state.cursors[name]
    if (!tracked || tracked.v !== cursor) state.cursors[name] = { v: cursor, at: now }
    if (head === null) {
      state.rpcFails[name]++
      return skip.push(key)
    }
    state.rpcFails[name] = 0
    const lag = head - cursor
    if (lag > window) {
      add({ key, kind: 'cursor-lag', severity: lag > 3 * window ? 'critical' : 'warn', title: `The ${name === 'xrpl' ? 'XRP Ledger' : 'XRPL EVM'} cursor is ${lag} ${unit} behind`, lines: [`cursor ${cursor}, chain head ${head}, allowed ${window}; the cursor has not moved for ${mins(now - state.cursors[name]!.at)}`] })
    }
  }
  const maxOf = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === 'number')
    return v.length ? Math.max(...v) : undefined
  }
  cursorRule('xrpl', maxOf(ok.map((n) => n.status?.cursor)), snap.chains.xrplHead, cfg.xrplLagLedgers, 'ledgers')
  const evmCursor = maxOf(ok.map((n) => n.status?.evmCursor))
  if (evmCursor !== undefined) cursorRule('evm', evmCursor, snap.chains.evmHead, cfg.evmLagBlocks, 'blocks')
  for (const name of ['xrpl', 'evm'] as const) {
    if (state.rpcFails[name] >= cfg.rpcDownPolls) add({ key: `rpc-down:${name}`, kind: 'rpc-down', severity: 'warn', title: `Cannot read the ${name === 'xrpl' ? 'XRP Ledger' : 'XRPL EVM'} head from the watchdog's RPCs`, lines: [`${state.rpcFails[name]} passes in a row: the cursor-lag check for this chain is blind`] })
  }

  // ---- the vote: contested and null views
  const contested: string[] = []
  const nullRounds: string[] = []
  for (const n of ok) {
    const t = state.nodes[n.index]
    const lr = n.status?.lastRound
    if (!lr) {
      skip.push('views-')
      continue
    }
    if (lr.winner === 'contested' || lr.evmWinner === 'contested') t.contested++
    else t.contested = 0
    const k = n.status?.k ?? reads?.operators?.k
    const top = Math.max(0, ...Object.values(lr.counts ?? {}))
    if (!lr.winner && lr.myView && typeof k === 'number' && top < k) t.nullRounds++
    else if (lr.winner || !lr.myView) t.nullRounds = 0
    if (t.contested >= cfg.contestedPolls) contested.push(`${n.label}: ${t.contested} passes`)
    if (t.nullRounds >= cfg.nullPolls) nullRounds.push(`${n.label}: ${t.nullRounds} passes, heard ${lr.heard ?? '?'}`)
  }
  if (contested.length) add({ key: 'views-contested', kind: 'views-contested', severity: 'critical', title: 'Two different ledger views each reached k votes', lines: ['nothing is applied while a round is contested', ...contested] })
  if (nullRounds.length) add({ key: 'views-null', kind: 'views-null', severity: 'warn', title: 'Views are proposed but none reaches k votes', lines: ['the nodes read different things from the ledgers (or cannot hear each other)', ...nullRounds] })

  // ---- what the watchdog itself could not read
  if (snap.blind.length) state.blindPolls++
  else state.blindPolls = 0
  if (state.blindPolls >= 3) add({ key: 'watchdog-blind', kind: 'watchdog-blind', severity: 'warn', title: 'The watchdog cannot read part of what it watches', lines: [`${state.blindPolls} passes in a row: ${snap.blind.join('; ')}`, 'the rules that need these reads are not checking anything'] })

  // ---- the cluster's own reads
  if (!reads) skip.push('transfers-', 'actions-', 'evm-actions-', 'unmatched-', 'token-', 'action-failed', 'evm-action-failed')
  else {
    const failed = (['operators', 'tokens', 'transfers', 'actions', 'evmActions', 'unmatched'] as const).filter((k) => reads[k] === null)
    if (failed.length) state.readFails++
    else state.readFails = 0
    if (state.readFails >= 3) add({ key: 'reads-failing', kind: 'reads-failing', severity: 'warn', title: 'Some cluster reads keep failing', lines: [`cannot read: ${failed.join(', ')} (from node ${reads.from}); the rules that need them are blind`] })
    if (failed.length) skip.push('reads-failing')

    // ---- transfers
    if (reads.transfers) {
      const held = reads.transfers.filter((t) => t.held)
      if (held.length) {
        add({ key: 'transfers-held', kind: 'transfers-held', severity: 'warn', title: `${held.length} transfer(s) held: a release the ledger refused`, lines: held.slice(0, 6).map((t) => `${short(t.id)} ${clean(t.sym, 12)} ${clean(t.amount, 16)}: ${clean(t.held?.result, 24)}, attempt ${t.held?.attempts ?? '?'}${t.held?.returning ? ', being minted back' : ''}${t.held?.until ? `, returned by ${new Date(t.held.until).toISOString().slice(0, 16)}Z if nothing changes` : ''}`).concat(held.length > 6 ? [`and ${held.length - 6} more`] : []), fingerprint: held.map((t) => t.id).sort().join(',') })
      }
      const waiting = reads.transfers.filter((t) => t.awaitingFee && !t.done && !t.failed && now - (t.updatedAt ?? t.createdAt ?? now) > cfg.awaitingFeeMinutes * 60_000)
      if (waiting.length) {
        add({ key: 'transfers-awaiting-fee', kind: 'transfers-awaiting-fee', severity: 'warn', title: `${waiting.length} lock(s) are waiting for their fee`, lines: ['tokens are in the lock account, nothing is minted, nothing expires: a user to reach', ...waiting.slice(0, 6).map((t) => `${short(t.id)} ${clean(t.sym, 12)} ${clean(t.amount, 16)} from ${short(t.from, 8)}, waiting ${mins(now - (t.updatedAt ?? t.createdAt ?? now))}, fee ${clean(t.awaitingFee?.feeXrp, 8)} XRP`)].concat(waiting.length > 6 ? [`and ${waiting.length - 6} more`] : []), fingerprint: waiting.map((t) => t.id).sort().join(',') })
      }
      const fresh = reads.transfers.filter((t) => t.failed && !cfg.ignoreFailed.includes(t.failed))
      const newlyFailed = fresh.filter((t) => !state.seen.transfersFailed.includes(t.id))
      if (!state.baselined.failed) {
        remember(state.seen.transfersFailed, fresh.map((t) => t.id))
      } else if (newlyFailed.length) {
        const worst = newlyFailed.some((t) => /not confirmed/.test(String(t.failed)))
        add({ key: `transfers-failed:${now}`, kind: 'transfers-failed', severity: worst ? 'critical' : 'warn', event: true, remember: { list: 'transfersFailed', ids: newlyFailed.map((t) => t.id) }, title: `${newlyFailed.length} transfer(s) ended in failure`, lines: newlyFailed.slice(0, 8).map((t) => `${short(t.id)} ${clean(t.dir, 4)} ${clean(t.sym, 12)} ${clean(t.amount, 16)}: ${clean(t.failed, 30)}`).concat(newlyFailed.length > 8 ? [`and ${newlyFailed.length - 8} more`] : []) })
      }
    } else skip.push('transfers-')

    // ---- XRPL actions
    if (reads.actions) {
      const stale = reads.actions.filter((a) => (a.status === 'queued' || a.status === 'pending') && now - (a.createdAt ?? now) > cfg.actionPendingMinutes * 60_000)
      if (stale.length) {
        const oldest = Math.max(...stale.map((a) => now - (a.createdAt ?? now)))
        add({ key: 'actions-pending', kind: 'actions-pending', severity: oldest > 4 * cfg.actionPendingMinutes * 60_000 ? 'critical' : 'warn', title: `${stale.length} XRPL action(s) pending for over ${cfg.actionPendingMinutes} minutes`, lines: stale.slice(0, 6).map((a) => `${short(a.id)} ${clean(a.kind, 14)} from ${clean(a.account, 8)}: ${a.status}, ${mins(now - (a.createdAt ?? now))}, attempt ${a.attempts ?? '?'}`).concat(stale.length > 6 ? [`and ${stale.length - 6} more`] : []), fingerprint: stale.map((a) => a.id).sort().join(',') })
      }
      const dead = reads.actions.filter((a) => a.status === 'failed' || a.status === 'expired')
      const newDead = dead.filter((a) => !state.seen.actionsFailed.includes(a.id))
      if (!state.baselined.failed) remember(state.seen.actionsFailed, dead.map((a) => a.id))
      else if (newDead.length) {
        add({ key: `action-failed:${now}`, kind: 'action-failed', severity: newDead.some((a) => a.status === 'failed') ? 'critical' : 'warn', event: true, remember: { list: 'actionsFailed', ids: newDead.map((a) => a.id) }, title: `${newDead.length} XRPL action(s) failed or expired`, lines: newDead.slice(0, 8).map((a) => `${short(a.id)} ${clean(a.kind, 14)} from ${clean(a.account, 8)}: ${a.status} after ${a.attempts ?? '?'} attempt(s)`) })
      }
    } else skip.push('actions-', 'action-failed')

    // ---- EVM actions
    if (reads.evmActions) {
      const limit = 3 * (nNodes || 1)
      const stuck = reads.evmActions.filter((a) => a.status === 'pending' && (a.attempts ?? 0) >= limit)
      if (stuck.length) add({ key: 'evm-actions-stuck', kind: 'evm-actions-stuck', severity: 'critical', title: `${stuck.length} EVM action(s) have used up their relayer attempts`, lines: [`${limit} attempts is 3 rounds of every operator relaying`, ...stuck.slice(0, 6).map((a) => `${short(a.id)} ${clean(a.kind, 8)}: ${a.attempts} attempts, ${mins(now - (a.createdAt ?? now))} old`)], fingerprint: stuck.map((a) => a.id).sort().join(',') })
      const slow = reads.evmActions.filter((a) => a.status === 'pending' && (a.attempts ?? 0) < limit && now - (a.createdAt ?? now) > cfg.actionPendingMinutes * 60_000)
      if (slow.length) add({ key: 'evm-actions-pending', kind: 'evm-actions-pending', severity: 'warn', title: `${slow.length} EVM action(s) pending for over ${cfg.actionPendingMinutes} minutes`, lines: slow.slice(0, 6).map((a) => `${short(a.id)} ${clean(a.kind, 8)}: ${mins(now - (a.createdAt ?? now))}, attempt ${a.attempts ?? '?'} of ${limit}`), fingerprint: slow.map((a) => a.id).sort().join(',') })
      const failedEvm = reads.evmActions.filter((a) => a.status === 'failed')
      const newFailedEvm = failedEvm.filter((a) => !state.seen.evmFailed.includes(a.id))
      if (!state.baselined.failed) remember(state.seen.evmFailed, failedEvm.map((a) => a.id))
      else if (newFailedEvm.length) {
        add({ key: `evm-action-failed:${now}`, kind: 'evm-action-failed', severity: 'critical', event: true, remember: { list: 'evmFailed', ids: newFailedEvm.map((a) => a.id) }, title: `${newFailedEvm.length} EVM action(s) gave up`, lines: newFailedEvm.slice(0, 8).map((a) => `${short(a.id)} ${clean(a.kind, 8)}: failed after ${a.attempts ?? '?'} attempts`) })
      }
    } else skip.push('evm-actions-', 'evm-action-failed')
    if (reads.transfers && reads.actions && reads.evmActions) state.baselined.failed = true

    // ---- unmatched payments
    if (reads.unmatched) {
      const hashes = reads.unmatched.map((u) => u.tx)
      if (!state.baselined.unmatched) {
        remember(state.seen.unmatched, hashes)
        state.baselined.unmatched = true
      } else {
        const fresh = reads.unmatched.filter((u) => !state.seen.unmatched.includes(u.tx))
        if (fresh.length) {
          add({ key: `unmatched-new:${now}`, kind: 'unmatched-new', severity: 'warn', event: true, remember: { list: 'unmatched', ids: fresh.map((u) => u.tx) }, title: `${fresh.length} new unmatched payment(s)`, lines: fresh.slice(0, 8).map((u) => `${short(u.tx, 12)} ledger ${u.ledger ?? '?'} from ${short(u.from, 10)} to ${short(u.to, 10)}: ${clean(u.amount?.value, 20)} ${clean(u.amount?.currency, 12)}, ${clean(u.reason, 24)}${u.memo ? `, memo "${clean(u.memo, 40)}"` : ''}`).concat(fresh.length > 8 ? [`and ${fresh.length - 8} more`] : []).concat(['a top-up of the lock or funding account shows up here too: expected']) })
        }
      }
    } else skip.push('unmatched-')

    // ---- tokens
    if (reads.tokens) {
      const syms = reads.tokens.map((t) => t.sym)
      if (!state.baselined.tokens) {
        remember(state.seen.tokens, syms)
        state.baselined.tokens = true
      } else {
        // The operator command for this cluster, ready to paste: through a node that answered (a label is "node 1 (host:port)"), and the mainnet operator key file is keys/admin-mainnet.json.
        const keyFile = reads.operators?.evmChainId === 1440000 ? 'keys/admin-mainnet.json' : 'keys/admin.json'
        const door = /\(([^()\s]+)\)$/.exec((snap.nodes.find((n) => n.ok) ?? snap.nodes[0])?.label ?? '')?.[1]
        const admin = (args: string) => `npx tsx scripts/admin.ts ${args} --key ${keyFile} --node ${clean(door, 60) || 'HOST:PORT'}`
        for (const t of reads.tokens.filter((x) => !state.seen.tokens.includes(x.sym))) {
          const pool = snap.pools[t.sym]
          const sym = clean(t.sym, 20)
          const suggestion = t.native ? { why: 'native XRP: nothing to price' } : pool === undefined ? { why: 'the pool was not read this pass' } : suggestCap(pool, cfg.suggestCapXrp, cfg.minPoolXrp)
          const how = t.autoOpen === true ? `opens by itself, with no limit, once its ERC-20 lands. To shut it: ${admin(`cap ${sym} 0`)}` : `waits for an operator: no deposits until it has a cap. To open it: ${admin(`cap ${sym} uncapped`)} (or a number of units)`
          add({ key: `token-new:${t.sym}`, kind: 'token-new', severity: 'info', event: true, remember: { list: 'tokens', ids: [t.sym] }, title: `New token listed: ${clean(t.ticker ?? t.sym, 14)}`, lines: [`${clean(t.name, 40)} (${sym}), ${clean(t.lane, 12) || 'lane ?'}, status ${clean(t.status, 12)}, issuer ${short(t.issuer, 12)}`, `current cap ${clean(t.capUnits, 20) || 'none'} units, locked ${clean(t.lockedUnits, 20) || '?'}${t.evmAddress ? `, ERC-20 ${short(t.evmAddress, 12)}` : ', no ERC-20 yet'}`, how, 'cap' in suggestion ? `suggested cap, if it should have one: ${suggestion.cap} units (${cfg.suggestCapXrp} XRP worth at the pool price: ${pool!.xrp} XRP / ${pool!.tokens} tokens). Off-consensus and read-only: set it by hand.` : `no cap suggestion: ${suggestion.why}`] })
        }
      }
    } else skip.push('token-')
  }

  // ---- XRP on the two accounts
  for (const role of ['lock', 'funding'] as const) {
    const a = snap.accounts?.[role]
    const key = `xrp-low:${role}`
    if (!a) {
      skip.push(key)
      continue
    }
    if (a.freeXrp < cfg.freeXrpWarn) {
      add({ key, kind: 'xrp-low', severity: a.freeXrp < cfg.freeXrpCritical ? 'critical' : 'warn', title: `The ${role} account is close to its reserve`, lines: [`${a.account}: ${a.balanceXrp.toFixed(3)} XRP, reserve ${a.reserveXrp.toFixed(3)}, ${a.freeXrp.toFixed(3)} XRP free (warn below ${cfg.freeXrpWarn}, critical below ${cfg.freeXrpCritical}). Every release, trust line and payout spends from here.`] })
    }
  }

  // ---- relayer gas
  if (snap.relayers) {
    const low = snap.relayers.filter((r) => r.balanceXrp < cfg.relayerMinXrp)
    if (snap.relayers.length && low.length === snap.relayers.length) add({ key: 'relayers-exhausted', kind: 'relayers-exhausted', severity: 'critical', title: 'Every relayer is out of gas', lines: [`no operator holds ${cfg.relayerMinXrp} XRP on XRPL EVM: mints, listings and returns cannot be sent`, ...low.map((r) => `${r.address}: ${r.balanceXrp.toFixed(4)} XRP`)] })
    else for (const r of low) add({ key: `relayer-low:${r.address.toLowerCase()}`, kind: 'relayer-low', severity: 'warn', title: `Relayer ${short(r.address, 12)} is low on gas`, lines: [`${r.address}${r.node ? ` (node ${short(r.node, 8)})` : ''}: ${r.balanceXrp.toFixed(4)} XRP on XRPL EVM, below ${cfg.relayerMinXrp}`] })
  } else skip.push('relayer-low:', 'relayers-exhausted')

  // ---- the lock account against what is minted
  if (snap.supply) {
    state.lastSupplyCheckAt = now
    const tol = toScaled(cfg.supplyTolerance) ?? 0n
    for (const row of snap.supply) {
      const key = `supply-short:${row.sym}`
      const holding = toScaled(row.holding)
      const supply = toScaled(row.supply)
      if (row.error || holding === null || supply === null) {
        skip.push(key)
        continue
      }
      // holding must cover the supply, within the relative tolerance
      const allowed = (supply * tol) / 10n ** BigInt(SCALE)
      if (holding + allowed < supply) {
        add({ key, kind: 'supply-short', severity: 'critical', title: `${clean(row.sym, 20)}: the lock account holds less than the ERC-20 supply`, lines: [`lock account holds ${row.holding}, total supply ${row.supply} (short by ${fromScaled(supply - holding)}). Pause mints now (RUNBOOK-INCIDENTS.md).`] })
      }
    }
  } else skip.push('supply-short:')

  return { findings, state, skip }
}

/** Whether a supply check is due: never done, or the interval has passed, or a shortfall is already being tracked. */
export function supplyDue(state: WatchState, now: number, cfg: WatchConfig): { due: boolean; onlyActive: boolean } {
  const anyActive = Object.keys(state.active).some((k) => k.startsWith('supply-short:'))
  const intervalPassed = state.lastSupplyCheckAt === undefined || now - state.lastSupplyCheckAt >= cfg.supplyEveryHours * 3_600_000
  if (intervalPassed) return { due: true, onlyActive: false }
  return { due: anyActive, onlyActive: anyActive }
}

// ------------------------------------------------------------------ what to send

export interface Message {
  /** The finding's key, so a message that could not be delivered can be taken back out of the state. */
  key: string
  kind: 'alert' | 'update' | 'reminder' | 'recovery' | 'event'
  severity: Severity
  title: string
  lines: string[]
  /** How long it has been firing, for reminders and recoveries. */
  forMs?: number
  remember?: Remember
}

const cooldownMs = (kind: string, cfg: WatchConfig) => (cfg.cooldownsByKind[kind] ?? cfg.cooldownMinutes) * 60_000

export function plan(ev: Evaluation, prevActive: WatchState['active'], cfg: WatchConfig, now: number): { messages: Message[]; active: WatchState['active'] } {
  const messages: Message[] = []
  const active: WatchState['active'] = { ...prevActive }
  const current = new Set<string>()
  const ordered = [...ev.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.key < b.key ? -1 : 1))
  for (const f of ordered) {
    if (f.event) {
      messages.push({ key: f.key, kind: 'event', severity: f.severity, title: f.title, lines: f.lines, remember: f.remember })
      continue
    }
    current.add(f.key)
    const was = prevActive[f.key]
    const fingerprint = f.fingerprint ?? ''
    if (!was) {
      messages.push({ key: f.key, kind: 'alert', severity: f.severity, title: f.title, lines: f.lines })
      active[f.key] = { kind: f.kind, severity: f.severity, title: f.title, since: now, lastSentAt: now, fingerprint }
    } else if (was.fingerprint !== fingerprint || SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[was.severity]) {
      messages.push({ key: f.key, kind: 'update', severity: f.severity, title: f.title, lines: f.lines, forMs: now - was.since })
      active[f.key] = { ...was, severity: f.severity, title: f.title, fingerprint, lastSentAt: now }
    } else if (now - was.lastSentAt >= cooldownMs(f.kind, cfg)) {
      messages.push({ key: f.key, kind: 'reminder', severity: f.severity, title: f.title, lines: f.lines, forMs: now - was.since })
      active[f.key] = { ...was, title: f.title, lastSentAt: now }
    } else {
      active[f.key] = { ...was, title: f.title }
    }
  }
  for (const [key, was] of Object.entries(prevActive)) {
    if (current.has(key)) continue
    if (ev.skip.some((p) => key === p || key.startsWith(p))) continue
    messages.push({ key, kind: 'recovery', severity: 'info', title: was.title, lines: [], forMs: now - was.since })
    delete active[key]
  }
  return { messages, active }
}

/**
 * After delivery: a message that did not go out must not be remembered as sent, or it never goes out. A new alert is
 * forgotten (so the next pass raises it again), a reminder or update keeps its old send time, a recovery stays active.
 */
export function undeliver(next: WatchState['active'], prev: WatchState['active'], failed: Message[]): WatchState['active'] {
  const out = { ...next }
  for (const m of failed) {
    if (m.kind === 'event') continue
    if (m.kind === 'alert') delete out[m.key]
    else if (prev[m.key]) out[m.key] = prev[m.key]
  }
  return out
}

/** Once events have really gone out, remember them, so the next pass does not raise them again. */
export function applyDelivered(state: WatchState, delivered: Message[]): WatchState {
  const next = structuredClone(state)
  for (const m of delivered) if (m.remember) remember(next.seen[m.remember.list], m.remember.ids)
  return next
}

const PREFIX: Record<Severity, string> = { critical: '[CRITICAL]', warn: '[WARN]', info: '[INFO]' }
export function render(m: Message): string {
  if (m.kind === 'recovery') return `[RECOVERED] ${m.title} (was firing for ${mins(m.forMs ?? 0)})`
  const head = m.kind === 'event' && m.severity === 'info' ? `[NEW] ${m.title}` : `${PREFIX[m.severity]}${m.kind === 'reminder' ? ' STILL FIRING' : m.kind === 'update' ? ' UPDATED' : ''} ${m.title}${m.kind === 'reminder' || m.kind === 'update' ? ` (for ${mins(m.forMs ?? 0)})` : ''}`
  return [head, ...m.lines.map((l) => `  ${l}`)].join('\n')
}

export interface Post {
  text: string
  messages: Message[]
}

/** Messages packed into as few posts as fit a chat limit; one that is too long alone is cut, not dropped. */
export function packMessages(messages: Message[], limit = 1900): Post[] {
  const posts: Post[] = []
  let current: Post | null = null
  for (const m of messages) {
    let t = render(m)
    if (t.length > limit) t = `${t.slice(0, limit - 20)}\n  ...(cut)`
    if (current && current.text.length + 2 + t.length > limit) {
      posts.push(current)
      current = null
    }
    if (current) {
      current.text += `\n\n${t}`
      current.messages.push(m)
    } else current = { text: t, messages: [m] }
  }
  if (current) posts.push(current)
  return posts
}
