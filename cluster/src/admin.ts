import { getAddress, isAddress } from 'viem'
import * as dec from './dec'
import { cleanName, parseImage } from './listing'
import { MAX_UNITS, owedBack, queueReturn, releaseAmount } from './machine'
import type { AdminLogEntry, State, TokenRec } from './types'

/**
 * Operator commands: the few things a person has to be able to do to a running bridge, as consensus inputs from a
 * HotPocket user whose key is in `config.admins`. Each is a plain state transition, so every node applies it the same
 * way, and each leaves a line in the admin log.
 *
 *   cap SYM UNITS|uncapped   what a token may have outstanding, and the minter's daily mint cap (one signed update)
 *   listings open|wait       whether a new listing opens by itself (machine.ts opensByItself) or waits for `cap`
 *   pause [SYM]              no new inbound transfers and no new mints, for one token or the whole bridge
 *   resume [SYM]             the opposite
 *   refund TX                send a payment the cluster could not use back to its sender
 *   meta SYM [name] [image]  a token's name and logo, for the listings its issuer can no longer change
 *   evm MINTER FROM          turn the EVM side on, once: the minter's address and the first block to read
 *
 * None of them can move funds anywhere but back to the account that sent them, and none can mint: a mint needs a lock.
 * What a stolen admin key can do is therefore grief (pause, rename, a wrong cap) and not steal, and that is why the key
 * list is genesis config rather than something a command can edit. `evm` is the one exception in kind: it names the
 * contract whose burns the cluster believes, which is a say over the locked funds. So it works exactly once, only while
 * the genesis's `evmPlan` is waiting for its minter, and only while nothing is locked behind the old arrangement.
 */

const LOG_CAP = 200

export type AdminResult = { ok: true; note: string } | { ok: false; error: string }

const fail = (error: string): AdminResult => ({ ok: false, error })
const done = (note: string): AdminResult => ({ ok: true, note })

/** The arguments a command was sent with, flattened to strings for the log. */
function argsOf(msg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(msg)) if (k !== 'type' && k !== 'cmd' && k !== 'id' && v !== undefined && v !== null) out[k] = String(v).slice(0, 200)
  return out
}

function record(s: State, by: string, cmd: string, msg: Record<string, unknown>, result: AdminResult, now: number): void {
  const entry: AdminLogEntry = { at: now, by: by.slice(0, 12), cmd, args: argsOf(msg), ok: result.ok, note: result.ok ? result.note : result.error }
  s.adminLog = [...(s.adminLog ?? []), entry].slice(-LOG_CAP)
}

/**
 * Applies one command from `by`, a user key. A key that is not an admin gets "not an operator" and leaves no trace: the
 * log is for what operators did, and a stranger must not be able to push it out.
 */
export function applyAdmin(s: State, by: string, msg: Record<string, unknown>, now: number): AdminResult {
  if (!s.config.admins?.includes(by)) return fail('not an operator')
  const cmd = String(msg.cmd ?? '')
  const result = run(s, cmd, msg, now)
  record(s, by, cmd, msg, result, now)
  return result
}

function tokenOf(s: State, msg: Record<string, unknown>): TokenRec | string {
  const sym = String(msg.sym ?? '').toUpperCase()
  return s.tokens[sym] ?? `unknown token ${sym || '(none given)'}`
}

function run(s: State, cmd: string, msg: Record<string, unknown>, now: number): AdminResult {
  switch (cmd) {
    case 'cap':
      return cap(s, msg)
    case 'listings':
      return listings(s, msg)
    case 'pause':
    case 'resume':
      return pause(s, msg, cmd === 'pause')
    case 'refund':
      return refund(s, msg, now)
    case 'meta':
      return meta(s, msg)
    case 'evm':
      return evm(s, msg)
    default:
      return fail(`unknown command ${JSON.stringify(cmd)}: cap, listings, pause, resume, refund, meta or evm`)
  }
}

/**
 * Turns the EVM side on from the genesis's plan, once the minter exists. A cluster starts XRPL-only because the minter's
 * signers are its own nodes' EVM keys, which do not exist until the nodes have booted; the minter is then deployed with
 * them and named here. `from` is the first block to read: the block the minter was deployed in, or an earlier one.
 * Refused when the EVM side is already on, when there is no plan, and when anything is locked already.
 */
function evm(s: State, msg: Record<string, unknown>): AdminResult {
  if (s.config.evm) return fail(`the EVM side is already on, with the minter ${s.config.evm.minter}; it is set once`)
  const plan = s.config.evmPlan
  if (!plan) return fail('this genesis has no evmPlan, so there is no EVM side waiting to be turned on')
  const locked = Object.values(s.tokens).find((t) => dec.gt(t.lockedUnits, '0'))
  if (locked) return fail(`${locked.sym} already has tokens locked: the EVM side has to be on before anything is bridged`)
  // isAddress is strict: a mixed-case address must carry a valid checksum (getAddress alone would quietly repair a typo).
  const given = String(msg.minter ?? '').trim()
  if (!isAddress(given)) return fail('minter must be the minter contract address: 0x and 40 hex digits, with a valid checksum if it has capitals')
  const minter = getAddress(given)
  if (/^0x0{40}$/.test(minter)) return fail('minter cannot be the zero address')
  const from = Number(msg.from)
  if (!Number.isSafeInteger(from) || from < 1) return fail('from must be a block number: the block the minter was deployed in, or an earlier one')
  s.config.evm = { ...plan, minter }
  delete s.config.evmPlan
  // The cursor names the last block already applied, so the first one read is `from`.
  s.cursor.evm = { block: from - 1, seen: [] }
  return done(`EVM side on: minter ${minter}, reading from block ${from}`)
}

function cap(s: State, msg: Record<string, unknown>): AdminResult {
  const token = tokenOf(s, msg)
  if (typeof token === 'string') return fail(token)
  // The cap goes to the minter as an update, which only exists for a token that has an ERC-20. Setting it earlier would be overwritten when the listing lands and the cluster adopts the cap it was listed with.
  if (!token.evmAddress) return fail(`${token.sym} has no ERC-20 yet: set its cap once the listing has landed on the EVM side`)
  const raw = String(msg.units ?? '').trim()
  if (raw.toLowerCase() === 'uncapped') {
    delete token.capUnits
  } else {
    let units: string
    try {
      units = dec.format(dec.parse(raw))
    } catch {
      return fail('units must be a decimal number, or "uncapped"')
    }
    if (dec.cmp(units, '0') < 0) return fail('units cannot be negative')
    if (dec.gt(units, MAX_UNITS)) return fail(`units above ${MAX_UNITS} cannot be minted; use "uncapped" for no limit`)
    token.capUnits = units
  }
  token.metaVersion = (token.metaVersion ?? 0) + 1
  return done(`${token.sym} cap ${token.capUnits ?? 'uncapped'}`)
}

/**
 * Whether new listings open by themselves (params.listingsOpen). It decides for listings from now on: a token already
 * listed keeps the cap it has, and `cap` stays the dial for each one, in both directions.
 */
function listings(s: State, msg: Record<string, unknown>): AdminResult {
  const mode = String(msg.mode ?? '').trim().toLowerCase()
  if (mode !== 'open' && mode !== 'wait') return fail('listings takes "open" (a new listing opens by itself) or "wait" (each one waits for an operator to set its cap)')
  const open = mode === 'open'
  if ((s.config.params.listingsOpen === true) === open) return fail(`new listings already ${open ? 'open by themselves' : 'wait for an operator'}`)
  if (open) s.config.params.listingsOpen = true
  else delete s.config.params.listingsOpen
  return done(open ? 'new listings open by themselves' : 'new listings wait for an operator')
}

function pause(s: State, msg: Record<string, unknown>, on: boolean): AdminResult {
  const wholeBridge = msg.sym === undefined || msg.sym === null || String(msg.sym).trim() === ''
  if (wholeBridge) {
    if ((s.paused === true) === on) return fail(`the bridge is already ${on ? 'paused' : 'running'}`)
    if (on) s.paused = true
    else delete s.paused
    return done(on ? 'bridge paused' : 'bridge resumed')
  }
  const token = tokenOf(s, msg)
  if (typeof token === 'string') return fail(token)
  if ((token.opPaused === true) === on) return fail(`${token.sym} is already ${on ? 'paused' : 'running'}`)
  if (on) token.opPaused = true
  else delete token.opPaused
  return done(`${token.sym} ${on ? 'paused' : 'resumed'}`)
}

/**
 * Sends a payment the cluster could not use back to whoever sent it: a lock still waiting for its fee, or an entry in the
 * unmatched list. It goes only to the recorded sender, never to an address the command names.
 */
function refund(s: State, msg: Record<string, unknown>, now: number): AdminResult {
  const tx = String(msg.tx ?? '').trim().toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(tx)) return fail('tx must be a 64-character XRP Ledger transaction hash')
  const waiting = Object.values(s.transfers).find((t) => t.dir === 'in' && t.srcTx === tx && ((t.step === 2 && t.failed === undefined) || owedBack(t)))
  if (waiting) {
    const token = s.tokens[waiting.sym]
    const back = queueReturn(s, 'lock', { tx, from: waiting.lockFrom! }, releaseAmount(token, waiting.amount), now)
    if (!back) return fail('too small to send back')
    waiting.failed = 'returned'
    waiting.refundActionId = back.id
    waiting.updatedAt = now
    return done(`lock ${tx.slice(0, 8)} (${waiting.amount} ${waiting.sym}) back to ${waiting.lockFrom} by ${back.id}`)
  }
  const stray = s.unmatched.find((u) => u.tx === tx)
  if (!stray) return fail('no lock waiting for its fee and no unmatched payment has that hash')
  if (stray.returned) return fail(`already sent back by ${stray.returned}`)
  const account = stray.to === s.config.xrpl.lockAccount ? 'lock' : stray.to === s.config.xrpl.fundingAccount ? 'funding' : null
  if (!account) return fail('that payment was not made to the lock or funding account')
  const back = queueReturn(s, account, { tx, from: stray.from }, stray.amount, now)
  if (!back) return fail('too small to send back: the return would cost more than it carries')
  stray.returned = back.id
  return done(`${stray.amount.value} ${stray.amount.currency} back to ${stray.from} by ${back.id}`)
}

function meta(s: State, msg: Record<string, unknown>): AdminResult {
  const token = tokenOf(s, msg)
  if (typeof token === 'string') return fail(token)
  const image = msg.image === undefined ? token.image : String(msg.image).trim() === '' ? undefined : parseImage(msg.image)
  if (image === null) return fail('image must be an https:// link or an ipfs:// link, as the coin publishes it')
  const name = msg.name === undefined ? token.name : cleanName(msg.name, token.ticker ?? token.sym)
  if (name === token.name && image === token.image) return fail('nothing changes')
  token.name = name
  if (image) token.image = image
  else delete token.image
  token.metaVersion = (token.metaVersion ?? 0) + 1
  return done(`${token.sym} named ${JSON.stringify(name)}${image ? ' with a logo' : ' without a logo'}`)
}
