import fs from 'node:fs'
import { isValidClassicAddress } from 'ripple-address-codec'
import { canon } from './canon'
import * as dec from './dec'
import type { Config, FeesRec, State, TokenRec } from './types'

/**
 * State lives in files in the contract's working directory, which HotPocket
 * hashes and subjects to consensus. One file per concern so a busy transfers
 * file does not rewrite the token list. All writes are canonical JSON and only
 * happen when the content changed.
 */
const FILES = {
  config: 'config.json',
  tokens: 'tokens.json',
  transfers: 'transfers.json',
  cursor: 'cursor.json',
  unmatched: 'unmatched.json',
  treasury: 'treasury.json',
  operators: 'operators.json',
  actions: 'actions.json',
  evmActions: 'evm-actions.json',
  accounts: 'accounts.json',
  fees: 'fees.json',
  admin: 'admin.json',
} as const

export const emptyFees = (): FeesRec => ({ xrp: '0', xrpByToken: {}, paidXrp: '0', owed: {}, payouts: [] })

const GENESIS_FILE = 'genesis.json'

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** A funding round as a snapshot from before the fee plan holds it; the machine no longer has them. */
interface RetiredRound {
  status?: string
  contributors?: Record<string, string>
  refunds?: { hash?: string }[]
  returns?: { hash?: string }[]
}

/** What a genesis file holds: a fresh one has a config, tokens and a cursor; a snapshot has the rest of a stopped cluster's state too, and an old one its funding rounds. */
type GenesisFile = Partial<State> & { config: Config; cursor: State['cursor']; rounds?: Record<string, RetiredRound> }

/**
 * The retired rounds that still owe somebody XRP: one open with contributions in it, or a refund or return the ledger
 * has not confirmed. Nothing in the machine pays them any more, so a snapshot that carries one is not started: the
 * contributors would be left holding a receipt for XRP the cluster no longer knows it owes.
 */
function roundsOwing(rounds: GenesisFile['rounds']): string[] {
  const owes = (r: RetiredRound) => (r.status === 'funding' && Object.keys(r.contributors ?? {}).length > 0) || [...(r.refunds ?? []), ...(r.returns ?? [])].some((x) => !x.hash)
  return Object.entries(rounds ?? {}).filter(([, r]) => owes(r)).map(([sym]) => sym).sort()
}

/**
 * A snapshot taken before the fee plan holds tokens in the old shape: the surplus counted as `feeUnits`, a cap priced
 * from a pool, and listings still waiting on a funding round. The surplus carries over as `dustUnits` (the lock account
 * holds lockedUnits + dustUnits either way); the pool-priced cap goes; a token still funding or refunded can never
 * finish, since the rounds are gone, and is dropped. Anything already in the new shape passes through.
 */
export function migrateTokens(tokens: Record<string, TokenRec>): Record<string, TokenRec> {
  const out: Record<string, TokenRec> = {}
  for (const [sym, t] of Object.entries(tokens)) {
    const { feeUnits, listCapUnits: _priced, ...rest } = t as TokenRec & { feeUnits?: string; listCapUnits?: string }
    if ((rest.status as string) === 'funding' || (rest.status as string) === 'refunded') continue
    out[sym] = { ...rest, dustUnits: rest.dustUnits ?? feeUnits ?? '0' }
  }
  return out
}

/** A decimal string as the state machine parses it; null when it is not one. */
function decimal(v: unknown): bigint | null {
  try {
    return typeof v === 'string' ? dec.parse(v) : null
  } catch {
    return null
  }
}

/**
 * What is wrong with a config, in words; empty when a node may run it. Every fee is a parameter, and a parameter that is
 * missing or malformed would otherwise show up as a crash in the middle of a consensus round, or as a default nobody
 * chose. A cluster that cannot start says why instead. Also the quorum rules: k of n must be a majority, or two groups
 * of k could each agree on a different view.
 */
export function configProblems(config: Config): string[] {
  const problems: string[] = []
  const whole = (name: string, v: unknown, min: number) => {
    if (!Number.isInteger(v) || (v as number) < min) problems.push(`${name} must be a whole number, ${min} or more, not ${JSON.stringify(v)}`)
  }
  // `xrp`: an amount of XRP, which a payment carries in whole drops. A finer one is quoted to the payer in drops (cut down) but judged in XRP (not), so someone who pays exactly the quote is turned away.
  const money = (name: string, v: unknown, positive: boolean, xrp = false) => {
    const n = decimal(v)
    if (n === null) problems.push(`${name} must be a decimal string, not ${JSON.stringify(v)}`)
    else if (positive ? n <= 0n : n < 0n) problems.push(`${name} must be ${positive ? 'above zero' : 'zero or more'}, not ${v as string}`)
    else if (xrp && !dec.isWholeDrops(v as string)) problems.push(`${name} must be a whole number of drops (6 decimals at most), not ${v as string}`)
  }
  whole('k', config.k, 1)
  whole('n', config.n, 1)
  if (Number.isInteger(config.k) && Number.isInteger(config.n)) {
    if (config.k > config.n) problems.push(`k (${config.k}) cannot be more than n (${config.n})`)
    else if (2 * config.k <= config.n) problems.push(`k=${config.k} of n=${config.n} is not a majority: two groups of ${config.k} could agree on different views`)
  }
  whole('intentTtlMs', config.intentTtlMs, 1)
  for (const a of config.admins ?? []) if (!/^ed[0-9a-f]{64}$/.test(a)) problems.push(`admins: ${JSON.stringify(a)} is not a HotPocket user public key ('ed' and 64 lower-case hex characters)`)
  const plan = config.evmPlan
  if (plan) {
    if (config.evm) problems.push('evmPlan is for a cluster that has no minter yet, and config.evm is set')
    whole('evmPlan.chainId', plan.chainId, 1)
    if (!Array.isArray(plan.rpc) || plan.rpc.length === 0 || plan.rpc.some((u) => typeof u !== 'string' || !/^https?:\/\/\S+$/.test(u))) problems.push('evmPlan.rpc must be a list of http(s) URLs')
    for (const name of ['windowBlocks', 'maxEventsPerView', 'pollMs', 'gasLimit', 'relayTimeoutMs'] as const) whole(`evmPlan.${name}`, plan[name], 1)
    whole('evmPlan.confirmations', plan.confirmations, 0)
  }
  const x = config.xrpl
  if (!x?.lockAccount || !x?.fundingAccount || x.lockAccount === x.fundingAccount) problems.push('xrpl.lockAccount and xrpl.fundingAccount must be two different accounts')
  if (x?.network !== undefined && x.network !== 'mainnet' && x.network !== 'test') problems.push(`xrpl.network must be mainnet or test, not ${JSON.stringify(x.network)}`)
  const p = config.params
  if (!p) return [...problems, 'params is missing']
  const split = p.split
  if (!split || !Number.isInteger(split.operators) || !Number.isInteger(split.treasury) || split.operators < 0 || split.treasury < 0 || split.operators + split.treasury !== 100) problems.push(`params.split must be whole percentages of operators and treasury adding up to 100, not ${JSON.stringify(split)}`)
  money('params.feeXrp', p.feeXrp, true, true)
  money('params.returnFeeXrp', p.returnFeeXrp, true, true)
  money('params.metaFeeXrp', p.metaFeeXrp, true, true)
  if (p.issuerListingFeeXrp !== undefined) money('params.issuerListingFeeXrp', p.issuerListingFeeXrp, true, true)
  money('params.trustLineLimit', p.trustLineLimit, true)
  money('params.defaultCapUnits', p.defaultCapUnits, false)
  if (p.listingsOpen !== undefined && typeof p.listingsOpen !== 'boolean') problems.push(`params.listingsOpen must be true or false, not ${JSON.stringify(p.listingsOpen)}`)
  if (typeof p.xrplFeeDrops !== 'string' || !/^[1-9]\d*$/.test(p.xrplFeeDrops)) problems.push(`params.xrplFeeDrops must be a whole number of drops above zero, not ${JSON.stringify(p.xrplFeeDrops)}`)
  whole('params.actionTtlLedgers', p.actionTtlLedgers, 1)
  for (const name of ['releaseRetryMs', 'releaseHoldMs', 'maxOpenIntents', 'maxOpenIntentsTotal'] as const) if (p[name] !== undefined) whole(`params.${name}`, p[name], 1)
  if (p.payout) {
    whole('params.payout.everyMs', p.payout.everyMs, 1)
    money('params.payout.minXrp', p.payout.minXrp, false, true)
    for (const name of ['minShareXrp', 'lockFloorXrp'] as const) if (p.payout[name] !== undefined) money(`params.payout.${name}`, p.payout[name], false, true)
    if (p.payout.operatorPayout !== undefined && (!isValidClassicAddress(p.payout.operatorPayout) || p.payout.operatorPayout === x?.lockAccount)) problems.push(`params.payout.operatorPayout must be an XRPL address other than the lock account, not ${JSON.stringify(p.payout.operatorPayout)}`)
    if (p.payout.treasuryAccount !== undefined && (!isValidClassicAddress(p.payout.treasuryAccount) || p.payout.treasuryAccount === x?.lockAccount)) problems.push(`params.payout.treasuryAccount must be an XRPL address other than the lock account, not ${JSON.stringify(p.payout.treasuryAccount)}`)
  }
  return problems
}

/** Refuses to run a config that configProblems finds fault with. */
function assertConfig(config: Config): void {
  const problems = configProblems(config)
  if (problems.length) throw new Error(`config is not runnable: ${problems.join('; ')}`)
}

/**
 * What is wrong with the trust line limits the genesis tokens carry; empty when a node may run them. A limit goes into a TrustSet
 * as it is written, so it has to be an amount the XRP Ledger takes: a plain decimal above zero with at most 16 significant digits.
 */
export function tokenProblems(tokens: Record<string, TokenRec>): string[] {
  const problems: string[] = []
  for (const [sym, t] of Object.entries(tokens)) {
    if (t.trustLimit === undefined) continue
    const v = t.trustLimit
    const significant = typeof v === 'string' ? v.replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length : 0
    if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v) || significant === 0) problems.push(`${sym}: trustLimit must be a plain decimal above zero, not ${JSON.stringify(v)}`)
    else if (significant > 16) problems.push(`${sym}: trustLimit ${v} has more than the 16 significant digits an XRP Ledger amount holds`)
  }
  return problems
}

/** The state a genesis file starts a cluster in. Pure, so the migration is tested without a file. */
export function stateFromGenesis(genesis: GenesisFile): State {
  assertConfig(genesis.config)
  const badTokens = tokenProblems(genesis.tokens ?? {})
  if (badTokens.length) throw new Error(`genesis tokens are not runnable: ${badTokens.join('; ')}`)
  const owing = roundsOwing(genesis.rounds)
  if (owing.length) throw new Error(`the snapshot still has funding rounds that owe XRP (${owing.join(', ')}); funding rounds are gone, so close or refund them on the old cluster first`)
  return {
    config: genesis.config,
    tokens: migrateTokens(genesis.tokens ?? {}),
    transfers: genesis.transfers ?? {},
    operators: genesis.operators ?? {},
    actions: genesis.actions ?? {},
    evmActions: genesis.evmActions ?? {},
    accounts: genesis.accounts ?? {},
    cursor: genesis.cursor,
    unmatched: genesis.unmatched ?? [],
    treasuryXrp: genesis.treasuryXrp ?? '0',
    fees: genesis.fees ?? emptyFees(),
    ...(genesis.paused ? { paused: true } : {}),
    ...(genesis.adminLog?.length ? { adminLog: genesis.adminLog } : {}),
  }
}

/**
 * Genesis is bundled with the contract, so every node starts from the same
 * file. A fresh genesis carries config, tokens and the cursor; a
 * snapshot (scripts/snapshot-state.sh) carries the whole state of a stopped
 * cluster, so queued releases, applied burns and the operator set survive a
 * redeploy instead of being replayed or forgotten.
 */
export function genesisState(): State {
  const genesis = readJson<GenesisFile>(GENESIS_FILE)
  if (!genesis) throw new Error(`${GENESIS_FILE} missing from the contract bundle`)
  return stateFromGenesis(genesis)
}

/** admin.json: the pause switch and the log of operator commands. Absent on a node from before operator commands. */
function adminFromFile(): Pick<State, 'paused' | 'adminLog'> {
  const a = readJson<{ paused?: boolean; log?: State['adminLog'] }>(FILES.admin)
  return { ...(a?.paused ? { paused: true } : {}), ...(a?.log?.length ? { adminLog: a.log } : {}) }
}

export function loadState(): { state: State; fresh: boolean } {
  const config = readJson<Config>(FILES.config)
  if (!config) return { state: genesisState(), fresh: true }
  assertConfig(config)
  return {
    fresh: false,
    state: {
      config,
      // Written by this code, so already in this shape. A node's files from before the fee plan do not get this far: their config is refused above, and the way across is a snapshot (see stateFromGenesis).
      tokens: readJson<State['tokens']>(FILES.tokens) ?? {},
      transfers: readJson<State['transfers']>(FILES.transfers) ?? {},
      operators: readJson<State['operators']>(FILES.operators) ?? {},
      actions: readJson<State['actions']>(FILES.actions) ?? {},
      evmActions: readJson<State['evmActions']>(FILES.evmActions) ?? {},
      accounts: readJson<State['accounts']>(FILES.accounts) ?? {},
      cursor: readJson<State['cursor']>(FILES.cursor) ?? genesisState().cursor,
      unmatched: readJson<State['unmatched']>(FILES.unmatched) ?? [],
      treasuryXrp: readJson<{ xrp: string }>(FILES.treasury)?.xrp ?? '0',
      fees: readJson<State['fees']>(FILES.fees) ?? emptyFees(),
      ...adminFromFile(),
    },
  }
}

/** Writes each file whose canonical content changed. Returns the files written. */
export function saveState(state: State): string[] {
  const parts: Record<string, unknown> = {
    [FILES.config]: state.config,
    [FILES.tokens]: state.tokens,
    [FILES.transfers]: state.transfers,
    [FILES.operators]: state.operators,
    [FILES.actions]: state.actions,
    [FILES.evmActions]: state.evmActions,
    [FILES.accounts]: state.accounts,
    [FILES.cursor]: state.cursor,
    [FILES.unmatched]: state.unmatched,
    [FILES.treasury]: { xrp: state.treasuryXrp },
    [FILES.fees]: state.fees,
    [FILES.admin]: { paused: state.paused === true, log: state.adminLog ?? [] },
  }
  const written: string[] = []
  for (const [file, value] of Object.entries(parts)) {
    const next = canon(value)
    let current: string | undefined
    try {
      current = fs.readFileSync(file, 'utf8')
    } catch {
      current = undefined
    }
    if (current !== next) {
      fs.writeFileSync(file, next)
      written.push(file)
    }
  }
  return written
}
