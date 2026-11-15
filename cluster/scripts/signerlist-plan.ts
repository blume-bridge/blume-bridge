/**
 * The decisions testnet-signerlist.ts makes before it signs anything, as pure functions: what the SignerList will hold,
 * whether it is valid, who can sign with it and whether anyone can sign alone, and which guards must pass before a
 * transaction is submitted. Nothing here reads a key or the network. A SignerList on the lock or funding account decides
 * who can move every locked token, and disabling the master key makes it permanent, so the rules are written down here
 * and tested instead of living in a script that only runs on mainnet.
 */
import { isValidClassicAddress } from 'ripple-address-codec'

/** XRPL: a SignerList holds 1 to 32 entries, each with a weight of 1 to 65535. */
export const MAX_SIGNERS = 32
export const MAX_WEIGHT = 65535

export type Role = 'operator' | 'recovery'

export interface Entry {
  address: string
  weight: number
  role: Role
  /** The HotPocket node public key for an operator, for the printout. */
  node?: string
}

export interface Plan {
  /** The account whose list this is. */
  account: string
  quorum: number
  entries: Entry[]
}

export interface Recovery {
  address: string
  weight: number
}

// ------------------------------------------------------------------ building

/** RECOVERY_SIGNER / RECOVERY_WEIGHT. The default weight is k - 1: useless alone, enough with any one operator. */
export function recoveryFromEnv(env: { RECOVERY_SIGNER?: string; RECOVERY_WEIGHT?: string }, k: number): Recovery | null {
  const address = env.RECOVERY_SIGNER?.trim() ?? ''
  const rawWeight = env.RECOVERY_WEIGHT?.trim() ?? ''
  if (!address) {
    if (rawWeight) throw new Error('RECOVERY_WEIGHT is set but RECOVERY_SIGNER is not')
    return null
  }
  if (!isValidClassicAddress(address)) throw new Error(`RECOVERY_SIGNER ${address} is not a classic r-address`)
  let weight = Math.max(1, k - 1)
  if (rawWeight) {
    weight = Number(rawWeight)
    if (!/^[0-9]+$/.test(rawWeight) || !Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT) throw new Error(`RECOVERY_WEIGHT must be a whole number from 1 to ${MAX_WEIGHT}, got '${rawWeight}'`)
  }
  return { address, weight }
}

export function buildPlan(opts: { account: string; operators: { address: string; node?: string }[]; k: number; recovery?: Recovery | null }): Plan {
  const entries: Entry[] = opts.operators.map((o) => ({ address: o.address, weight: 1, role: 'operator' as const, node: o.node }))
  if (opts.recovery) entries.push({ address: opts.recovery.address, weight: opts.recovery.weight, role: 'recovery' })
  entries.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
  return { account: opts.account, quorum: opts.k, entries }
}

/** What the ledger wants in a SignerListSet. */
export function signerListSetTx(plan: Plan) {
  return {
    TransactionType: 'SignerListSet' as const,
    Account: plan.account,
    SignerQuorum: plan.quorum,
    SignerEntries: plan.entries.map((e) => ({ SignerEntry: { Account: e.address, SignerWeight: e.weight } })),
  }
}

// ------------------------------------------------------------------ validity

/** Everything the ledger would reject, and the ways a list can be valid yet useless. Empty means fine. */
export function validatePlan(plan: Plan): string[] {
  const errors: string[] = []
  if (!isValidClassicAddress(plan.account)) errors.push(`the account ${plan.account} is not a classic r-address`)
  if (!Number.isInteger(plan.quorum) || plan.quorum < 1) errors.push(`the quorum must be a whole number of at least 1, got ${plan.quorum}`)
  if (plan.entries.length < 1) errors.push('the list has no entries')
  if (plan.entries.length > MAX_SIGNERS) errors.push(`the list has ${plan.entries.length} entries; XRPL allows ${MAX_SIGNERS}`)
  const seen = new Set<string>()
  for (const e of plan.entries) {
    if (!isValidClassicAddress(e.address)) errors.push(`${e.role} entry ${e.address} is not a classic r-address`)
    if (seen.has(e.address)) errors.push(`${e.address} appears twice in the list`)
    seen.add(e.address)
    if (e.address === plan.account) errors.push(`${e.address} is the account itself: an account cannot be on its own list`)
    if (!Number.isInteger(e.weight) || e.weight < 1 || e.weight > MAX_WEIGHT) errors.push(`${e.address} has weight ${e.weight}; it must be a whole number from 1 to ${MAX_WEIGHT}`)
  }
  const total = totalWeight(plan)
  if (Number.isInteger(plan.quorum) && plan.quorum > total) errors.push(`the quorum ${plan.quorum} is more than all the weights together (${total}): nothing could ever sign`)
  return errors
}

export const totalWeight = (plan: Plan): number => plan.entries.reduce((sum, e) => sum + e.weight, 0)

// ------------------------------------------------------------------ who can sign

export interface WeightClass {
  role: Role
  weight: number
  count: number
}
export interface Combo {
  /** How many of each class sign, in the order of the classes. */
  counts: number[]
  /** In words: "any 3 of the 5 operator keys", "the recovery key plus any 1 of the 5 operator keys". */
  text: string
}
export interface Analysis {
  quorum: number
  total: number
  classes: WeightClass[]
  /** Entries whose weight alone meets the quorum. */
  alone: Entry[]
  /** The smallest sets that reach the quorum, by class; null when there are too many classes to list. */
  combos: Combo[] | null
}

function classesOf(plan: Plan): WeightClass[] {
  const map = new Map<string, WeightClass>()
  for (const e of plan.entries) {
    const key = `${e.role}:${e.weight}`
    const c = map.get(key) ?? { role: e.role, weight: e.weight, count: 0 }
    c.count++
    map.set(key, c)
  }
  // The recovery key first: "the recovery key plus any 1 of the 5 operator keys" reads better than the other way round.
  return [...map.values()].sort((a, b) => (a.role === b.role ? b.weight - a.weight : a.role === 'recovery' ? -1 : 1))
}

function describeClass(c: WeightClass, taken: number): string {
  const noun = c.role === 'operator' ? 'operator key' : 'recovery key'
  const weight = c.weight === 1 && c.role === 'operator' ? '' : ` (weight ${c.weight}${c.count > 1 ? ' each' : ''})`
  if (c.count === 1) return `the ${noun}${weight}`
  if (taken === c.count) return `all ${c.count} ${noun}s${weight}`
  return `any ${taken} of the ${c.count} ${noun}s${weight}`
}

const MAX_ENUMERATION = 200_000

/**
 * Who can sign. Entries of one role and weight are interchangeable, so the minimal signing sets are counted per class
 * ("any 3 of the 5 operator keys") instead of listing the 10 subsets.
 */
export function analyse(plan: Plan): Analysis {
  const classes = classesOf(plan)
  const alone = plan.entries.filter((e) => e.weight >= plan.quorum)
  const space = classes.reduce((p, c) => p * (c.count + 1), 1)
  let combos: Combo[] | null = null
  if (space <= MAX_ENUMERATION) {
    combos = []
    const counts = new Array<number>(classes.length).fill(0)
    const weightOf = (v: number[]) => v.reduce((sum, n, i) => sum + n * classes[i].weight, 0)
    const walk = (i: number) => {
      if (i === classes.length) {
        const w = weightOf(counts)
        // minimal: reaches the quorum, and no one who signed could be left out
        if (w >= plan.quorum && counts.every((n, j) => n === 0 || w - classes[j].weight < plan.quorum)) {
          const parts = counts.map((n, j) => (n > 0 ? describeClass(classes[j], n) : '')).filter(Boolean)
          combos!.push({ counts: [...counts], text: parts.join(' plus ') })
        }
        return
      }
      for (let n = 0; n <= classes[i].count; n++) {
        counts[i] = n
        walk(i + 1)
      }
      counts[i] = 0
    }
    walk(0)
    // The ordinary route first (operators alone), then the ways that go through the recovery key; fewest signers first within each.
    const usesRecovery = (c: Combo) => c.counts.some((n, i) => n > 0 && classes[i].role === 'recovery')
    const signers = (c: Combo) => c.counts.reduce((x, y) => x + y, 0)
    combos.sort((a, b) => Number(usesRecovery(a)) - Number(usesRecovery(b)) || signers(a) - signers(b))
  }
  return { quorum: plan.quorum, total: totalWeight(plan), classes, alone, combos }
}

/** The lines the script prints for a plan. */
export function describePlan(plan: Plan, label: string): string[] {
  const a = analyse(plan)
  const lines = [`${label} ${plan.account}: quorum ${plan.quorum}, ${plan.entries.length} entries, total weight ${a.total}`]
  for (const e of plan.entries) lines.push(`    ${e.address}  weight ${e.weight}  ${e.role}${e.node ? ` (node ${e.node.slice(0, 10)})` : ''}`)
  if (a.combos === null) lines.push('    (too many different weights to list the signing combinations)')
  else {
    lines.push('    These combinations can sign:')
    for (const c of a.combos) lines.push(`      - ${c.text}`)
  }
  if (a.alone.length) {
    for (const e of a.alone) lines.push(`    !!! ${e.address} (${e.role}, weight ${e.weight}) CAN SIGN ALONE: its weight meets the quorum of ${plan.quorum}. !!!`)
  } else {
    lines.push('    No single entry can sign alone.')
  }
  return lines
}

/** What an account's own flags add to "who can sign": the master key and a regular key each sign alone, whatever the list says. */
export function accountSignersNote(info: { masterDisabled: boolean; regularKey: string | null }): string[] {
  const lines: string[] = []
  if (!info.masterDisabled) lines.push('    Master key: ENABLED. Until it is disabled this account can still be signed for by that one key, whatever the list says.')
  else lines.push('    Master key: disabled.')
  if (info.regularKey) lines.push(`    !!! A regular key (${info.regularKey}) is set: that ONE key can sign alone, whatever the list says. !!!`)
  return lines
}

// ------------------------------------------------------------------ the operator set the cluster reports

export interface OperatorsRead {
  k: number
  n: number
  ready: boolean
  lockAccount?: string
  fundingAccount?: string
  signers: { node: string; xrplAddress: string }[]
}

/** Is this a set worth installing. `requireAccounts` is set on mainnet, where a cluster that does not name its accounts cannot be checked at all. */
export function checkOperators(ops: OperatorsRead, accounts: { lock: string; funding: string }, requireAccounts: boolean): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!ops.ready) errors.push('the operator set is not agreed yet (ready: false)')
  if (!Number.isInteger(ops.k) || !Number.isInteger(ops.n) || ops.k < 1 || ops.k > ops.n) errors.push(`the cluster reports k=${ops.k} n=${ops.n}`)
  if (!Array.isArray(ops.signers) || ops.signers.length === 0) errors.push('the cluster reports no operators')
  else {
    if (ops.signers.length !== ops.n) errors.push(`the cluster says n=${ops.n} but lists ${ops.signers.length} operator(s)`)
    const seen = new Set<string>()
    for (const s of ops.signers) {
      if (!isValidClassicAddress(String(s.xrplAddress))) errors.push(`operator ${String(s.node).slice(0, 10)} has no valid XRPL address`)
      if (seen.has(s.xrplAddress)) errors.push(`${s.xrplAddress} is listed for two operators`)
      seen.add(s.xrplAddress)
    }
  }
  for (const [role, mine, theirs] of [['lock', accounts.lock, ops.lockAccount], ['funding', accounts.funding, ops.fundingAccount]] as const) {
    if (theirs === undefined) {
      const msg = `the cluster does not say which ${role} account it watches, so these operators cannot be matched to ${mine}`
      if (requireAccounts) errors.push(msg)
      else warnings.push(msg)
    } else if (theirs !== mine) {
      errors.push(`the cluster watches ${theirs} as its ${role} account but the key file's ${role} account is ${mine}: this is another cluster's operator set`)
    }
  }
  return { errors, warnings }
}

// ------------------------------------------------------------------ guards

/** Mainnet never takes the default operator source, which is the dev cluster on localhost:8081. */
export function networkGuard(opts: { network: string; bridgeQuery: string | undefined }): { ok: true } | { ok: false; reason: string } {
  if (opts.network === 'mainnet' && !(opts.bridgeQuery ?? '').trim()) {
    return {
      ok: false,
      reason: 'XRPL_NETWORK=mainnet needs BRIDGE_QUERY set explicitly to a command that prints the mainnet cluster\'s `operators` read. The default asks the dev cluster, and its keys would be installed on the mainnet accounts (and made permanent by --disable-master).',
    }
  }
  return { ok: true }
}

export interface Flags {
  yes: boolean
  dryRun: boolean
  disableMaster: boolean
  confirmDisableMaster: boolean
}
export function parseFlags(argv: string[]): Flags {
  const known = new Set(['--yes', '--dry-run', '--disable-master', '--confirm-disable-master'])
  for (const a of argv) if (!known.has(a)) throw new Error(`unknown argument ${a}: expected ${[...known].join(', ')}`)
  const has = (f: string) => argv.includes(f)
  const flags = { yes: has('--yes'), dryRun: has('--dry-run'), disableMaster: has('--disable-master'), confirmDisableMaster: has('--confirm-disable-master') }
  if (flags.confirmDisableMaster && !flags.disableMaster) throw new Error('--confirm-disable-master only goes with --disable-master')
  return flags
}

export type Confirmation = { kind: 'none' } | { kind: 'flag' } | { kind: 'typed'; expect: string } | { kind: 'refuse'; reason: string }

/**
 * How the submit step is confirmed. A dry run signs nothing and needs nothing. Otherwise --yes is enough for the
 * SignerListSet, or a typed YES at a terminal; with neither, nothing is submitted.
 */
export function submitConfirmation(f: Flags, interactive: boolean): Confirmation {
  if (f.dryRun) return { kind: 'none' }
  if (f.yes) return { kind: 'flag' }
  if (interactive) return { kind: 'typed', expect: 'YES' }
  return { kind: 'refuse', reason: 'nothing is submitted without --yes, or a typed YES at a terminal. Use --dry-run to see the transactions.' }
}

/**
 * Disabling the master key is separate and never implied: --yes does not cover it. It needs its own flag
 * (--confirm-disable-master) or a typed phrase at a terminal, shown after the text that says it cannot be undone.
 */
export function disableMasterConfirmation(f: Flags, interactive: boolean): Confirmation {
  if (!f.disableMaster || f.dryRun) return { kind: 'none' }
  if (f.confirmDisableMaster) return { kind: 'flag' }
  if (interactive) return { kind: 'typed', expect: 'DISABLE MASTER' }
  return { kind: 'refuse', reason: '--disable-master is irreversible and needs its own confirmation: --confirm-disable-master, or a typed DISABLE MASTER at a terminal. --yes does not cover it.' }
}

/** Does what was typed satisfy the confirmation? Exact, so a stray 'yes' or 'Y' never submits. */
export function accepts(c: Confirmation, typed: string): boolean {
  if (c.kind === 'none' || c.kind === 'flag') return true
  if (c.kind === 'typed') return typed.trim() === c.expect
  return false
}

// ------------------------------------------------------------------ comparing with the ledger

export interface LedgerSignerList {
  quorum: number
  entries: { address: string; weight: number }[]
}
/** Is the list on the ledger exactly this plan, weights included. */
export function sameList(current: LedgerSignerList | null, plan: Plan): boolean {
  if (!current || current.quorum !== plan.quorum || current.entries.length !== plan.entries.length) return false
  const a = [...current.entries].sort((x, y) => (x.address < y.address ? -1 : 1))
  const b = [...plan.entries].sort((x, y) => (x.address < y.address ? -1 : 1))
  return a.every((e, i) => e.address === b[i].address && e.weight === b[i].weight)
}
