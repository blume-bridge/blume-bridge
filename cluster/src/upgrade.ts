import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { gunzipSync } from 'node:zlib'

/**
 * The rules for changing a running cluster's code. Pure: no files, no HotPocket, so the whole policy is tested on its own
 * (src/loader.ts does the file work). See docs/BRIDGE_UPGRADES.md.
 *
 * An Evernode instance takes no second bundle, so the code that runs is `app.js`, loaded by a tiny fixed `index.js` (the
 * loader) that also accepts these messages. Who may send them is a list of HotPocket user keys in the loader's own state,
 * seeded from the genesis. Any one of them is enough: this is deliberately the lean version (no delay, no approvals).
 *
 * The three messages, all `{type:"upgrade", op, version}` from an upgrader key, `version` being the loader's current
 * version plus one so that an old message can never be played again:
 *   code      {hash, gz}     replace app.js with the gzipped code in `gz`, whose SHA-256 is `hash`
 *   rollback                 swap app.js with the previous version
 *   keys      {upgraders}    replace the list of upgrader keys (the cure for a key that may have leaked)
 */

/** Compressed code an upgrade may carry (base64 makes the message a third bigger, well inside HotPocket's 5 MiB). */
export const MAX_GZ_BYTES = 3 * 1024 * 1024
/** What it may unpack to. */
export const MAX_CODE_BYTES = 16 * 1024 * 1024
export const MAX_UPGRADERS = 5
const HISTORY = 20

const USER_KEY = /^ed[0-9a-f]{64}$/
const SHA256 = /^[0-9a-f]{64}$/

export interface UpgradeState {
  /** Counts every accepted change, code or keys. The next message must carry this plus one. */
  version: number
  /** SHA-256 of app.js as installed (hex). */
  hash: string
  /** HotPocket user keys ('ed' and 64 hex characters) that may change the code. Any one is enough. Empty: the code can never change. */
  upgraders: string[]
  history: { version: number; what: 'start' | 'code' | 'rollback' | 'keys'; hash: string; at: number }[]
  /**
   * What became of the latest message from an upgrader, so the sender can read the answer back (`code` read) instead of being
   * sent one. A reply is a consensus output, outputs are compared across nodes, and one node out of step in that round
   * (a resync is routine) stalled the dev cluster for good on 2026-10-18.
   */
  last?: UpgradeOutcome
}

export interface UpgradeOutcome {
  /** The request id the sender gave, if any. */
  id?: string
  ok: boolean
  op?: string
  error?: string
  /** The first 12 characters of the sender's key. */
  by: string
  at: number
}

/** The outcome of a message, the same on every node (the error text is capped). */
export function outcome(by: string, at: number, result: { ok: true; op: string; id?: string } | { ok: false; error: string; op?: string; id?: string }): UpgradeOutcome {
  return { ...(result.id !== undefined ? { id: result.id } : {}), ok: result.ok, ...(result.op !== undefined ? { op: result.op } : {}), ...(result.ok ? {} : { error: result.error.slice(0, 300) }), by: by.slice(0, 12), at }
}

export type UpgradeMessage =
  | { op: 'code'; version: number; hash: string; gz: string }
  | { op: 'rollback'; version: number }
  | { op: 'keys'; version: number; upgraders: string[] }

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** Why a list of upgrader keys is not usable, or nothing. */
export function keyProblems(keys: unknown): string[] {
  if (!Array.isArray(keys)) return ['upgraders must be a list of keys']
  const problems: string[] = []
  if (keys.length > MAX_UPGRADERS) problems.push(`at most ${MAX_UPGRADERS} upgrader keys`)
  for (const k of keys) if (typeof k !== 'string' || !USER_KEY.test(k)) problems.push(`${JSON.stringify(k)} is not a HotPocket user key ('ed' and 64 lower-case hex characters)`)
  if (new Set(keys).size !== keys.length) problems.push('an upgrader key is listed twice')
  return problems
}

/** The state of a loader that has just started its first round. */
export function startState(appHash: string, upgraders: string[], now: number): UpgradeState {
  return { version: 1, hash: appHash, upgraders: [...upgraders], history: [{ version: 1, what: 'start', hash: appHash, at: now }] }
}

/** A state read back from disk, or why it cannot be trusted. */
export function readState(value: unknown): { state: UpgradeState } | { error: string } {
  const v = value as Partial<UpgradeState> | null
  if (!v || typeof v !== 'object') return { error: 'not an object' }
  if (!Number.isSafeInteger(v.version) || (v.version as number) < 1) return { error: 'bad version' }
  if (typeof v.hash !== 'string' || !SHA256.test(v.hash)) return { error: 'bad hash' }
  const problems = keyProblems(v.upgraders)
  if (problems.length) return { error: problems[0] }
  if (!Array.isArray(v.history)) return { error: 'bad history' }
  if (v.last !== undefined && (typeof v.last !== 'object' || v.last === null || typeof (v.last as UpgradeOutcome).ok !== 'boolean')) return { error: 'bad last outcome' }
  return { state: v as UpgradeState }
}

export function isUpgrader(state: UpgradeState, publicKey: string): boolean {
  return state.upgraders.includes(publicKey)
}

/**
 * What a message from `raw` is. null: not an upgrade message at all (the app gets it). An error: it says it is one but is not
 * well formed, which the sender is told rather than the app.
 */
export function parseUpgrade(raw: Buffer): { message: UpgradeMessage; id?: string } | { error: string; id?: string } | null {
  let value: any
  try {
    const text = raw.toString('utf8').trimStart()
    if (text[0] !== '{') return null
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || value.type !== 'upgrade') return null
  // Echoed in the answer so a client can match it to its request.
  const id = typeof value.id === 'string' ? value.id.slice(0, 64) : undefined
  if (!Number.isSafeInteger(value.version) || value.version < 1) return { error: 'version must be a whole number, 1 or more', id }
  switch (value.op) {
    case 'code':
      if (typeof value.hash !== 'string' || !SHA256.test(value.hash)) return { error: 'hash must be the SHA-256 of the code, in lower-case hex', id }
      if (typeof value.gz !== 'string' || value.gz.length === 0) return { error: 'gz must be the gzipped code in base64', id }
      return { message: { op: 'code', version: value.version, hash: value.hash, gz: value.gz }, id }
    case 'rollback':
      return { message: { op: 'rollback', version: value.version }, id }
    case 'keys':
      return { message: { op: 'keys', version: value.version, upgraders: value.upgraders }, id }
    default:
      return { error: `unknown op ${JSON.stringify(value.op)}: code, rollback or keys`, id }
  }
}

/** Why this source is not a module the loader could run, or nothing. It compiles the way Node wraps a CommonJS file, so a top-level `return` is as fine as it is in a module. */
export function compileProblem(code: string): string | null {
  try {
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${code}\n})`, { filename: 'app.next.js' })
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export type Decision = { ok: true; next: UpgradeState; install: { code: Buffer } | { swap: true } | null } | { ok: false; error: string }

/**
 * Whether a message from an upgrader is accepted, and what the loader must then do. `prevHash` is the hash of app.prev.js
 * (null when there is none); `now` is the consensus time, so every node writes the same history.
 */
export function decide(state: UpgradeState, message: UpgradeMessage, now: number, prevHash: string | null): Decision {
  if (message.version !== state.version + 1) return { ok: false, error: `version must be ${state.version + 1} (this cluster is at ${state.version})` }
  const bump = (what: UpgradeState['history'][number]['what'], hash: string, upgraders = state.upgraders): UpgradeState => ({
    version: message.version,
    hash,
    upgraders: [...upgraders],
    history: [...state.history, { version: message.version, what, hash, at: now }].slice(-HISTORY),
  })
  switch (message.op) {
    case 'keys': {
      const problems = keyProblems(message.upgraders)
      if (problems.length) return { ok: false, error: problems[0] }
      if (message.upgraders.length === 0) return { ok: false, error: 'a cluster with no upgrader can never be changed again; refusing to remove the last key' }
      return { ok: true, next: bump('keys', state.hash, message.upgraders), install: null }
    }
    case 'rollback':
      if (!prevHash) return { ok: false, error: 'there is no previous version to go back to' }
      return { ok: true, next: bump('rollback', prevHash), install: { swap: true } }
    case 'code': {
      if (message.gz.length > Math.ceil((MAX_GZ_BYTES * 4) / 3) + 4) return { ok: false, error: `the code is over ${MAX_GZ_BYTES} bytes compressed` }
      let code: Buffer
      try {
        code = gunzipSync(Buffer.from(message.gz, 'base64'), { maxOutputLength: MAX_CODE_BYTES })
      } catch (e) {
        return { ok: false, error: `gz is not gzip data within ${MAX_CODE_BYTES} bytes: ${(e as Error).message}` }
      }
      if (sha256(code) !== message.hash) return { ok: false, error: 'the code does not match its hash' }
      const problem = compileProblem(code.toString('utf8'))
      if (problem) return { ok: false, error: `the code does not compile: ${problem}` }
      return { ok: true, next: bump('code', message.hash), install: { code } }
    }
  }
}
