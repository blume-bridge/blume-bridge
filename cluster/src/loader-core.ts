import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import type { HpContext, HpUser } from 'hotpocket-nodejs-contract'
import { log as defaultLog } from './log'
import { decide, isUpgrader, keyProblems, outcome, parseUpgrade, readState, sha256, startState, type Decision, type UpgradeState } from './upgrade'

/**
 * The fixed half of the contract (docs/BRIDGE_UPGRADES.md). `index.js` is this, and the cluster's real work is `app.js`
 * (src/contract.ts), which this loads each round. An Evernode instance takes no second bundle, so the loader is what makes a
 * running cluster changeable: it accepts upgrade messages from the upgrader keys (src/upgrade.ts holds the rules), swaps the
 * app, and keeps going when the app is broken, so a bad upload can always be followed by a good one.
 *
 * Files, all in the contract's state directory (so every node holds the same ones):
 *   app.js         the application
 *   app.prev.js    the version before it, for a fallback and for `rollback`
 *   upgrade.json   version, hash, upgrader keys and a short history; created on the first round from genesis.json's `upgrade`
 * Nothing else here touches the app's own state files.
 */

const APP = 'app.js'
const PREV = 'app.prev.js'
const TMP = 'app.tmp.js'
const STATE = 'upgrade.json'
const GENESIS = 'genesis.json'
/** A read request is a few bytes; a bigger first input is not one. */
const READ_PEEK_BYTES = 1024
/** An upgrader's message: the compressed code as base64 plus the envelope. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024 + 4096

export interface AppModule {
  contract(ctx: HpContext): Promise<void> | void
}
export interface Loaded {
  app: AppModule | null
  which: 'app' | 'prev' | 'none'
  error: string | null
}
export interface Deps {
  /** The state directory. The contract's working directory in production. */
  dir?: string
  /** Where the loader says what it did. The shared node log by default (src/log.ts). */
  log?: (line: string) => void
}

const at = (dir: string, name: string) => path.join(dir, name)

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** rename, or copy and delete where the file system will not rename. */
function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to)
  } catch {
    fs.copyFileSync(from, to)
    fs.unlinkSync(from)
  }
}

function writeAtomic(file: string, data: Buffer | string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, data)
  moveFile(tmp, file)
}

const hashOfFile = (file: string): string | null => (fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null)

/**
 * Evaluates a file as a CommonJS module. Not `require`, so a round that loads two versions never sees a cache, and so an
 * error names the file. Throws when it does not load or exports no `contract` function.
 */
export function loadModule(file: string): AppModule {
  const code = fs.readFileSync(file, 'utf8')
  const module = { exports: {} as any }
  const wrapper = new vm.Script(`(function (exports, require, module, __filename, __dirname) {${code}\n})`, { filename: file }).runInThisContext()
  wrapper.call(module.exports, module.exports, createRequire(file), module, file, path.dirname(file))
  if (typeof module.exports.contract !== 'function') throw new Error(`${path.basename(file)} exports no contract function`)
  return module.exports as AppModule
}

/** The app, or the version before it when the app will not load, or nothing. The cause of a fallback is returned, not hidden. */
export function loadApp(dir: string, log: (line: string) => void): Loaded {
  let error: string | null = null
  for (const [name, which] of [[APP, 'app'], [PREV, 'prev']] as const) {
    const file = at(dir, name)
    if (!fs.existsSync(file)) continue
    try {
      const app = loadModule(file)
      if (which === 'prev') log(`${APP} did not load (${error}); running ${PREV}`)
      return { app, which, error }
    } catch (e) {
      error = `${name}: ${(e as Error).message}`
      log(`${error}`)
    }
  }
  return { app: null, which: 'none', error }
}

/**
 * The state of the loader. On the first round it is made from the genesis (the upgrader keys in `upgrade.upgraders`; none
 * listed means the code can never change) and, in a writable round, saved. Afterwards a swap that was cut off is put right:
 * the recorded hash is the truth, and the file that carries it is the app.
 */
export function ensureState(dir: string, now: number, log: (line: string) => void, writable: boolean): UpgradeState | null {
  const file = at(dir, STATE)
  if (fs.existsSync(file)) {
    const read = readState(readJson(file))
    if ('error' in read) {
      log(`${STATE} cannot be trusted (${read.error}): upgrades are off`)
      return null
    }
    if (writable) reconcile(dir, read.state, log)
    return read.state
  }
  const appHash = hashOfFile(at(dir, APP))
  if (!appHash) {
    log(`no ${APP}: nothing to load or upgrade`)
    return null
  }
  let upgraders: string[] = readJson(at(dir, GENESIS))?.upgrade?.upgraders ?? []
  const problems = keyProblems(upgraders)
  if (problems.length) {
    log(`the genesis names unusable upgrader keys (${problems[0]}): upgrades are off`)
    upgraders = []
  }
  const state = startState(appHash, upgraders, now)
  if (writable) writeAtomic(file, JSON.stringify(state))
  return state
}

function reconcile(dir: string, state: UpgradeState, log: (line: string) => void): void {
  const app = at(dir, APP)
  const tmp = at(dir, TMP)
  if (hashOfFile(app) === state.hash) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    return
  }
  for (const name of [TMP, PREV]) {
    if (hashOfFile(at(dir, name)) === state.hash) {
      fs.copyFileSync(at(dir, name), app)
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
      log(`${APP} did not match the recorded version; restored it from ${name}`)
      return
    }
  }
  log(`${APP} does not match the recorded version and no copy does: running what is there`)
}

/** Carries out an accepted decision. The state file is written last, so a cut-off swap is undone by `reconcile`. */
function install(dir: string, decision: Extract<Decision, { ok: true }>, next: UpgradeState): void {
  const app = at(dir, APP)
  const prev = at(dir, PREV)
  const tmp = at(dir, TMP)
  if (decision.install && 'code' in decision.install) {
    fs.writeFileSync(tmp, decision.install.code)
    if (fs.existsSync(app)) moveFile(app, prev)
    moveFile(tmp, app)
  } else if (decision.install && 'swap' in decision.install) {
    moveFile(app, tmp)
    moveFile(prev, app)
    moveFile(tmp, prev)
  }
  writeAtomic(at(dir, STATE), JSON.stringify(next))
}

/**
 * One round. Upgrade messages and code reads are taken out of the inputs before the app sees them; everything else is
 * the app's. The app runs after any upgrade of this round, so the new code handles the very round that installed it.
 */
export async function runRound(ctx: HpContext, deps: Deps = {}): Promise<void> {
  const dir = deps.dir ?? process.cwd()
  const log = deps.log ?? ((line: string) => defaultLog(`loader: ${line}`))
  let state = ensureState(dir, ctx.timestamp, log, !ctx.readonly)
  let handled = 0
  let left = 0

  for (const user of ctx.users.list()) {
    const keep: [number, number][] = []
    for (const input of user.inputs) {
      let taken = false
      try {
        taken = await take(user, input)
      } catch (e) {
        log(`an input could not be examined: ${(e as Error).message}`)
      }
      if (taken) handled++
      else keep.push(input)
    }
    user.inputs = keep
    left += keep.length
  }

  // A read that was only a code read has nothing for the app to do: do not load it.
  if (ctx.readonly && handled > 0 && left === 0) return
  const loaded = loadApp(dir, log)
  if (loaded.app) await loaded.app.contract(ctx)
  else log('no app could be loaded: this round does nothing')

  async function take(user: HpUser, input: [number, number]): Promise<boolean> {
    const size = input[1]
    if (ctx.readonly) {
      if (size > READ_PEEK_BYTES) return false
      const text = (await ctx.users.read(input)).toString('utf8').trimStart()
      if (text[0] !== '{') return false
      let msg: any
      try {
        msg = JSON.parse(text)
      } catch {
        return false
      }
      if (msg?.type !== 'code') return false
      // A read is not part of consensus, so answering it is safe (an upgrade's answer is not sent; see UpgradeState.last).
      try {
        await user.send(codeInfo(ctx, dir, state, log, typeof msg.id === 'string' ? msg.id.slice(0, 64) : undefined))
      } catch (e) {
        log(`could not answer a code read: ${(e as Error).message}`)
      }
      return true
    }
    // Only an upgrader's input is ever examined, so a stranger's cannot make the loader read, parse or decompress anything.
    if (!state || !isUpgrader(state, user.publicKey)) return false
    // The answer is written into the state (`last`) for a `code` read to return, never sent: see UpgradeState.last.
    const record = (result: Parameters<typeof outcome>[2]) => {
      state = { ...state!, last: outcome(user.publicKey, ctx.timestamp, result) }
      writeAtomic(at(dir, STATE), JSON.stringify(state))
    }
    if (size > MAX_MESSAGE_BYTES) {
      record({ ok: false, error: `a message of ${size} bytes is over the ${MAX_MESSAGE_BYTES} an upgrade may weigh` })
      return true
    }
    const parsed = parseUpgrade(await ctx.users.read(input))
    if (!parsed) return false
    if ('error' in parsed) {
      record({ ok: false, error: parsed.error, id: parsed.id })
      return true
    }
    const decision = decide(state, parsed.message, ctx.timestamp, hashOfFile(at(dir, PREV)))
    if (!decision.ok) {
      log(`refused ${parsed.message.op} v${parsed.message.version} from ${user.publicKey.slice(0, 12)}: ${decision.error}`)
      record({ ok: false, error: decision.error, op: parsed.message.op, id: parsed.id })
      return true
    }
    const next: UpgradeState = { ...decision.next, last: outcome(user.publicKey, ctx.timestamp, { ok: true, op: parsed.message.op, id: parsed.id }) }
    install(dir, decision, next)
    state = next
    log(`${parsed.message.op} v${state.version} installed from ${user.publicKey.slice(0, 12)}, hash ${state.hash.slice(0, 12)}`)
    return true
  }
}

/** What a `{type:"code"}` read answers: which code this node runs, and whether it loads. */
function codeInfo(ctx: HpContext, dir: string, state: UpgradeState | null, log: (line: string) => void, id?: string): Record<string, unknown> {
  const loaded = loadApp(dir, log)
  return {
    type: 'code',
    id,
    node: ctx.publicKey,
    version: state?.version ?? null,
    hash: state?.hash ?? null,
    appHash: hashOfFile(at(dir, APP)),
    prevHash: hashOfFile(at(dir, PREV)),
    upgraders: state?.upgraders ?? [],
    history: state?.history.slice(-5) ?? [],
    last: state?.last ?? null,
    loaded: loaded.which,
    error: loaded.error ?? (state ? null : 'upgrades are off (no usable upgrade.json)'),
  }
}
