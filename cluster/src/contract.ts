import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { HpContext, HpUser } from 'hotpocket-nodejs-contract'
import { applyAdmin } from './admin'
import { listActions, listTokens, listTransfers, toAction, toBridgeToken, toIntentReply, toOperators, toTransfer } from './api'
import { cmpStr, hashOf, isRequest, own, shortId } from './canon'
import { listEvmActions, toEvmAction } from './api'
import { attestationCounts, ingestAttestations, loadAttestations, myAttestations, persistAttestations, relayReady } from './attest'
import { evmView, readEvmBalances } from './feed/evm'
import { configureNode } from './feed/node'
import { fakeView, readFakeChain } from './feed/fake'
import { readAccount, readBalances, readTrustLines, xrplView } from './feed/xrpl'
import { ensureKeys, loadKeys, publicKeys } from './keys'
import { log } from './log'
import { applyEvmView, applyKeys, applyView, clone, createIntent, createTestBurn, fromWei, tick, validateIntent, validateTestBurn, type Applied } from './machine'
import { computeShares, payoutOf } from './payout'
import { ingestSignatures, loadSigs, mySignatures, persistSigs, signatureCounts, submitReady } from './signing'
import { loadState, saveState } from './state'
import type { KeysView, OperatorKeys, State, View } from './types'
import { startCollector, tally, voteWaitMs, type ViewVote } from './vote'

/**
 * The application: `app.js` in the bundle. The fixed loader (src/loader.ts, `index.js`) hands it every round and accepts
 * upgrades to it (src/loader-core.ts), so this file exports `contract` and does not start HotPocket itself. Runs once per
 * consensus round (and once per read request, in read-only mode). Consensus rounds: take user inputs,
 * read the ledger, vote over NPL, apply what k nodes agreed on, save.
 */

const FEED_TIMEOUT_MS = 900
/**
 * The EVM view's own budget. A round is a fresh process, so every round opens a new TLS connection to the EVM RPC
 * before its three or four calls; from a node a few hundred milliseconds from it (rpc.xrplevm.org is in us-east-1,
 * the India node is ~350 ms a call) that is well over FEED_TIMEOUT_MS, and the view never made it. With three nodes
 * the two fast ones carried the vote; with one down, the EVM side stopped (2026-11-04).
 */
const EVM_FEED_TIMEOUT_MS = 3000
const EVM_FEED_BUDGET_MS = EVM_FEED_TIMEOUT_MS + 400
const READ_TIMEOUT_MS = 2500
/** Node-local files. `../` is the contract's non-consensus directory (everpocket keeps signer keys there); /tmp is the container's. */
const NODE_FILE = '../bridge-node.json'
const TMP_NODE_FILE = '/tmp/bridge-node.json'
const LAST_ROUND_FILE = '/tmp/bridge-last-round.json'
/** Test hook: sleep this many ms before broadcasting, to play a slow node. */
const DELAY_FILE = '/tmp/bridge-delay-ms'
/** Other nodes' public keys heard so far, node-local, until the operator set is agreed. */
const KEYS_SEEN_FILE = '../keys-seen.json'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function readJson(path: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function stateHash(state: State): string {
  return hashOf({ tokens: state.tokens, transfers: state.transfers, cursor: state.cursor, unmatched: state.unmatched, treasuryXrp: state.treasuryXrp, fees: state.fees, paused: state.paused === true, adminLog: state.adminLog ?? [] })
}

/** Writes the node-local identity files once. Their nonces differ per node on purpose: if `../` were consensed, ledgers would stop closing. */
function ensureNodeFiles(ctx: HpContext): void {
  for (const path of [NODE_FILE, TMP_NODE_FILE]) {
    if (readJson(path)) continue
    try {
      fs.writeFileSync(path, JSON.stringify({ node: ctx.publicKey, firstLcl: ctx.lclSeqNo, nonce: randomBytes(8).toString('hex'), writtenAt: Date.now() }))
    } catch (e) {
      log(`node file ${path}: ${(e as Error).message}`)
    }
  }
}

// ---------------------------------------------------------------- reads

async function handleRead(state: State, msg: any, ctx: HpContext): Promise<unknown> {
  const now = ctx.timestamp
  const base = { id: msg.id, node: ctx.publicKey }
  const cfg = state.config
  const tokens = Object.values(state.tokens)
  switch (msg.type) {
    case 'status':
      return {
        ...base,
        type: 'status',
        contractId: ctx.contractId,
        readonly: ctx.readonly,
        timestamp: ctx.timestamp,
        feed: cfg.feed,
        k: cfg.k,
        n: cfg.n,
        cursor: state.cursor.xrpl.ledger,
        evmCursor: state.cursor.evm?.block ?? null,
        evm: cfg.evm ? { minter: cfg.evm.minter, chainId: cfg.evm.chainId } : null,
        counts: { tokens: tokens.length, transfers: Object.keys(state.transfers).length, unmatched: state.unmatched.length, operators: Object.keys(state.operators).length, actions: Object.keys(state.actions).length },
        feeXrp: cfg.params.feeXrp,
        fees: { xrp: state.fees.xrp, paidXrp: state.fees.paidXrp },
        myKeys: (() => {
          const k = loadKeys()
          return k ? { xrpl: k.xrpl.address, evm: k.evm.address } : null
        })(),
        accounts: state.accounts,
        stateHash: stateHash(state),
        nodeFile: readJson(NODE_FILE),
        tmpFile: readJson(TMP_NODE_FILE),
        lastRound: readJson(LAST_ROUND_FILE),
      }
    case 'operators':
      return { ...base, type: 'operators', ...toOperators(state) }
    case 'actions':
      return { ...base, type: 'actions', actions: listActions(state, signatureCounts(loadSigs())) }
    case 'evmActions':
      return { ...base, type: 'evmActions', actions: listEvmActions(state, attestationCounts(loadAttestations())) }
    case 'evmAction': {
      const a = own(state.evmActions, String(msg.id ?? ''))
      return a ? { ...base, type: 'evmAction', action: toEvmAction(a, attestationCounts(loadAttestations())[a.id]) } : { ...base, type: 'error', error: 'unknown evm action' }
    }
    case 'action': {
      const a = own(state.actions, String(msg.id ?? ''))
      return a ? { ...base, type: 'action', action: toAction(a, signatureCounts(loadSigs())[a.id]) } : { ...base, type: 'error', error: 'unknown action' }
    }
    case 'tokens':
      return { ...base, type: 'tokens', tokens: listTokens(state) }
    case 'token': {
      const t = own(state.tokens, String(msg.sym ?? '').toUpperCase())
      return t ? { ...base, type: 'token', token: toBridgeToken(t) } : { ...base, type: 'error', error: 'unknown token' }
    }
    case 'transfer': {
      const t = own(state.transfers, String(msg.id ?? msg.transferId ?? ''))
      if (!t) return { ...base, type: 'error', error: 'unknown transfer' }
      const local = t.dir === 'in' ? (t.evmActionId ? attestationCounts(loadAttestations())[t.evmActionId]?.sigs : undefined) : t.actionId ? signatureCounts(loadSigs())[t.actionId]?.sigs : undefined
      return { ...base, type: 'transfer', transfer: toTransfer(state, t, local) }
    }
    case 'transfers':
      return { ...base, type: 'transfers', transfers: listTransfers(state, msg) }
    case 'unmatched':
      return { ...base, type: 'unmatched', unmatched: state.unmatched.slice(-50) }
    case 'balances': {
      const xrpl: Record<string, string> = cfg.feed === 'xrpl' && msg.xrpl ? await readBalances(cfg.xrpl, tokens, String(msg.xrpl), READ_TIMEOUT_MS).catch(() => ({})) : {}
      const evm: Record<string, string> = cfg.evm && msg.evm ? await readEvmBalances(cfg.evm, tokens, String(msg.evm), READ_TIMEOUT_MS).catch(() => ({})) : {}
      const balances: Record<string, { xrpl: number; evm: number }> = {}
      for (const t of tokens) balances[t.sym] = { xrpl: Number(xrpl[t.sym] ?? 0), evm: Number(evm[t.sym] ? fromWei(evm[t.sym]) : 0) }
      return { ...base, type: 'balances', balances }
    }
    case 'trustlines': {
      if (cfg.feed !== 'xrpl' || !msg.xrpl) return { ...base, type: 'trustlines', trustlines: {} }
      return { ...base, type: 'trustlines', trustlines: await readTrustLines(cfg.xrpl, tokens, String(msg.xrpl), READ_TIMEOUT_MS).catch(() => ({})) }
    }
    case 'account': {
      // What a release to this address would meet: whether it exists, whether it demands a destination tag or pre-approval, and which listed tokens it trusts. Read-only, not consensus; the app checks it before a burn, which is final.
      if (cfg.feed !== 'xrpl' || !msg.xrpl) return { ...base, type: 'account', account: null }
      return { ...base, type: 'account', account: await readAccount(cfg.xrpl, tokens, String(msg.xrpl), READ_TIMEOUT_MS).catch(() => null) }
    }
    case 'log': {
      // Evernode instances have no shell; this is the only way to read a node's log.
      let text = ''
      try {
        text = fs.readFileSync('/tmp/bridge-cluster.log', 'utf8')
      } catch {
        /* no log yet */
      }
      const lines = text.split('\n').filter(Boolean)
      const n = Math.min(Math.max(1, Number(msg.lines) || 40), 200)
      return { ...base, type: 'log', total: lines.length, lines: lines.slice(-n) }
    }
    case 'payouts': {
      // What the next payout would be, worked out the way the scheduler works it out, so an operator can see why they have or have not been paid.
      const plan = computeShares(state, now)
      return {
        ...base,
        type: 'payouts',
        params: cfg.params.payout ?? null,
        split: cfg.params.split,
        fees: { ...state.fees, payouts: state.fees.payouts.slice(-20) },
        distributable: plan.distributable,
        lockTopUp: plan.lockTopUp,
        blocked: plan.blocked ?? null,
        kept: plan.kept,
        accruals: plan.accruals,
        pay: plan.pay,
        totalXrp: plan.totalXrp,
        operators: Object.values(state.operators).map((o) => ({ node: o.node, xrplAddress: o.xrplAddress, payoutAddress: payoutOf(state, o) })),
      }
    }
    case 'ping':
      return { ...base, type: 'pong', readonly: ctx.readonly, lcl: ctx.readonly ? undefined : ctx.lclSeqNo }
    default:
      return { ...base, type: 'error', error: `unknown type ${String(msg.type)}` }
  }
}

// ---------------------------------------------------------------- inputs (consensus)

/** Requests one user key may have answered in a round, and all keys together. A flood costs the cluster time in every round it lasts. */
const MAX_INPUTS_PER_USER = 20
const MAX_INPUTS_PER_ROUND = 200

async function handleInputs(state: State, ctx: HpContext): Promise<{ state: State; applied: Applied[] }> {
  let s = state
  const applied: Applied[] = []
  const users = [...ctx.users.list()].sort((a, b) => cmpStr(a.publicKey, b.publicKey))
  let round = 0
  for (const user of users) {
    let mine = 0
    for (const input of user.inputs) {
      // A round answers only so many requests, per key and in all: the rest are told to wait, unread. Every node sees the same inputs in the same order, so every node drops the same ones.
      if (++mine > MAX_INPUTS_PER_USER || ++round > MAX_INPUTS_PER_ROUND) {
        await user.send({ type: 'error', error: 'too many requests this round: try again in a moment' }).catch(() => undefined)
        continue
      }
      // Nothing a user sends may throw out of the round: every node would throw at the same input, the HotPocket wrapper would end the process before it voted or saved, and the round would be lost cluster-wide. A failing input is answered and skipped, and `s` only changes when an input has finished.
      try {
        s = await handleInput(s, user, input, ctx, applied)
      } catch (e) {
        log(`input from ${user.publicKey.slice(0, 8)} failed and was skipped: ${(e as Error).message}`)
        await user.send({ type: 'error', error: 'bad request' }).catch(() => undefined)
      }
    }
  }
  return { state: s, applied }
}

/** One user input. Returns the state after it; throws only for a bug, which handleInputs contains. */
async function handleInput(s: State, user: HpUser, input: [number, number], ctx: HpContext, applied: Applied[]): Promise<State> {
  const raw = await ctx.users.read(input)
  let msg: any
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    await user.send({ type: 'error', error: 'invalid JSON' })
    return s
  }
  if (!isRequest(msg)) {
    await user.send({ type: 'error', error: 'a request is a JSON object' })
    return s
  }
  if (msg.type === 'intent.transfer') {
    const v = validateIntent(s, msg, user.publicKey)
    if (!v.ok) {
      await user.send({ id: msg.id, type: 'error', error: v.error })
      return s
    }
    const id = shortId('intent', ctx.lclSeqNo, user.publicKey, raw.toString('hex'))
    const r = createIntent(s, v.intent, id, ctx.timestamp, user.publicKey, true)
    const reply = toIntentReply(r.state, r.transfer)
    applied.push({ kind: 'intent', detail: `${id} ${v.intent.dir} ${v.intent.amount} ${v.intent.sym} ${v.intent.from} → ${v.intent.to}` })
    await user.send({ id: msg.id, type: 'intent.transfer.result', ...reply, lcl: ctx.lclSeqNo })
    return r.state
  }
  if (msg.type === 'admin') {
    // An operator command, from a user key the genesis lists. A stranger is turned away before anything is copied. Applied to a copy so a command that half-ran cannot leave the round's state torn.
    if (!s.config.admins?.includes(user.publicKey)) {
      await user.send({ id: msg.id, type: 'admin.result', ok: false, error: 'not an operator', lcl: ctx.lclSeqNo })
      return s
    }
    const c = clone(s)
    const r = applyAdmin(c, user.publicKey, msg, ctx.timestamp)
    if (r.ok) applied.push({ kind: 'admin', detail: `${String(msg.cmd)}: ${r.note}` })
    await user.send({ id: msg.id, type: 'admin.result', ok: r.ok, ...(r.ok ? { note: r.note } : { error: r.error }), lcl: ctx.lclSeqNo })
    return c
  }
  if (msg.type === 'test.burn') {
    const v = validateTestBurn(s, msg)
    if (!v.ok) {
      await user.send({ id: msg.id, type: 'error', error: v.error })
      return s
    }
    const id = shortId('burn', ctx.lclSeqNo, user.publicKey, raw.toString('hex'))
    const r = createTestBurn(s, v, id, ctx.timestamp)
    const reply = { transfer: toTransfer(r.state, r.transfer), action: toAction(r.action) }
    applied.push({ kind: 'test.burn', detail: `${id} ${v.amount} ${v.sym} → ${v.to}; release ${r.action.id} queued` })
    await user.send({ id: msg.id, type: 'test.burn.result', ...reply, lcl: ctx.lclSeqNo })
    return r.state
  }
  if (msg.type === 'balances' || msg.type === 'trustlines' || msg.type === 'account') {
    // These read the ledgers. Inputs run before the vote, so a slow RPC here would delay this node's broadcast; read requests have their own budget.
    await user.send({ id: msg.id, type: 'error', error: 'use a read request' })
    return s
  }
  await user.send(await handleRead(s, msg, ctx))
  return s
}

// ---------------------------------------------------------------- operator keys

function readKeysSeen(): Record<string, OperatorKeys> {
  return (readJson(KEYS_SEEN_FILE) as Record<string, OperatorKeys> | null) ?? {}
}

/** Remembers keys other nodes broadcast; returns the full set once every UNL node is known. */
function keysView(ctx: HpContext, mine: OperatorKeys, heard: OperatorKeys[]): KeysView | null {
  const seen = readKeysSeen()
  seen[mine.node] = mine
  for (const k of heard) seen[k.node] = k
  try {
    fs.writeFileSync(KEYS_SEEN_FILE, JSON.stringify(seen))
  } catch {
    /* node-local only */
  }
  const unl = ctx.unl.list().map((n) => n.publicKey)
  if (unl.some((n) => !seen[n])) return null
  return { src: 'keys', set: unl.sort().map((n) => seen[n]) }
}

// ---------------------------------------------------------------- views

/** The two chains are read at the same time, so the EVM budget adds nothing to the XRP Ledger read. */
async function myViews(state: State): Promise<View[]> {
  const xrpl = (async (): Promise<View | null> => {
    try {
      if (state.config.feed === 'fake') {
        const chain = readFakeChain()
        return chain ? fakeView(state, chain) : null
      }
      return await Promise.race([xrplView(state, FEED_TIMEOUT_MS), sleep(FEED_TIMEOUT_MS + 400).then(() => null)])
    } catch (e) {
      log(`feed: ${(e as Error).message}`)
      return null
    }
  })()
  const evm = (async (): Promise<View | null> => {
    if (!state.config.evm || !state.cursor.evm) return null
    try {
      return await Promise.race([evmView(state, EVM_FEED_TIMEOUT_MS), sleep(EVM_FEED_BUDGET_MS).then(() => null)])
    } catch (e) {
      log(`evm feed: ${(e as Error).message}`)
      return null
    }
  })()
  return (await Promise.all([xrpl, evm])).filter((v): v is View => v !== null)
}

// ---------------------------------------------------------------- main

export async function contract(ctx: HpContext): Promise<void> {
  const started = Date.now()
  const { state: loaded, fresh } = loadState()
  configureNode(ctx.publicKey, { xrpl: loaded.config.xrpl.rotate !== false, evm: (loaded.config.evm ?? loaded.config.evmPlan)?.rotate !== false })

  if (ctx.readonly) {
    for (const user of ctx.users.list()) {
      for (const input of user.inputs) {
        let msg: any
        try {
          msg = JSON.parse((await ctx.users.read(input)).toString())
        } catch {
          await user.send({ type: 'error', error: 'invalid JSON' })
          continue
        }
        if (!isRequest(msg)) {
          await user.send({ type: 'error', error: 'a request is a JSON object' })
          continue
        }
        try {
          await user.send(await handleRead(loaded, msg, ctx))
        } catch (e) {
          log(`read failed: ${(e as Error).message}`)
          await user.send({ id: msg.id, type: 'error', error: 'bad request' }).catch(() => undefined)
        }
      }
    }
    return
  }

  // Consensus round. Register the NPL handler before anything slow so no message is missed.
  const collector = startCollector(ctx, ctx.lclSeqNo)
  ensureNodeFiles(ctx)
  // Once this node is an admitted operator its keys are never made again (keys.ts): a missing file is restored from backup, not replaced.
  const keys = ensureKeys({ mayGenerate: !Object.hasOwn(loaded.operators, ctx.publicKey) })
  const mine = publicKeys(ctx.publicKey, keys)
  const roundtime = Number((await ctx.getConfig().catch(() => null))?.consensus?.roundtime) || 2000
  const voteTimeoutMs = Math.ceil(roundtime / 2)
  const now = ctx.timestamp

  const inputs = await handleInputs(loaded, ctx)
  let state = inputs.state
  const applied: Applied[] = [...inputs.applied]
  if (fresh) applied.push({ kind: 'genesis', detail: `feed=${state.config.feed} k=${state.config.k} n=${state.config.n} cursor=${state.cursor.xrpl.ledger}` })

  // Signatures for actions that were pending at the end of the last round, so peers can submit this round.
  const sigCache = loadSigs()
  const sigs = mySignatures(state, keys, sigCache)
  const attCache = loadAttestations()
  const att = await myAttestations(state, keys, attCache)
  const operatorsReady = Object.keys(state.operators).length >= state.config.n
  const views: View[] = await myViews(state)
  const keysProposal = operatorsReady ? null : keysView(ctx, mine, [])
  if (keysProposal) views.push(keysProposal)
  const delay = Number(fs.existsSync(DELAY_FILE) ? fs.readFileSync(DELAY_FILE, 'utf8') : 0)
  if (delay > 0) await sleep(delay)
  const myVotes = await collector.send({ views, keys: operatorsReady ? undefined : mine, sigs, att })
  const { votes, keys: heardKeys, sigs: heardSigs, att: heardAtt, heard, timedOut } = await collector.collect(Math.max(0, ctx.unl.count() - 1), voteWaitMs(started, Date.now(), voteTimeoutMs, EVM_FEED_BUDGET_MS))
  if (!operatorsReady && heardKeys.length) keysView(ctx, mine, heardKeys)
  const all: ViewVote[] = [...myVotes, ...votes]

  // Only views for the window at the cursor count; a stale view from a node that is behind must not reach k.
  let winner: string | undefined
  const result = tally(all.filter((v) => v.src === 'xrpl' && v.view.src === 'xrpl' && v.view.from === state.cursor.xrpl.ledger && (v.view.skip ?? 0) === (state.cursor.xrpl.skip ?? 0)), state.config.k)
  if (result.contested) winner = 'contested'
  else if (result.winner && result.winner.view.src === 'xrpl') {
    const r = applyView(state, result.winner.view, now)
    state = r.state
    applied.push(...r.applied)
    winner = `${result.winner.hash.slice(0, 8)}×${result.winner.votes} → ledger ${result.winner.view.to} (${result.winner.view.events.length} events)`
  }
  if (!operatorsReady) {
    const keysResult = tally(all.filter((v) => v.src === 'keys'), state.config.k)
    if (keysResult.winner && keysResult.winner.view.src === 'keys') {
      const r = applyKeys(state, keysResult.winner.view.set, ctx.unl.list().map((n) => n.publicKey))
      state = r.state
      applied.push(...r.applied)
    }
  }
  let evmWinner: string | undefined
  const evmCursor = state.cursor.evm?.block
  const evmResult = tally(all.filter((v) => v.src === 'evm' && v.view.src === 'evm' && evmCursor !== undefined && v.view.from === evmCursor && (v.view.skip ?? 0) === (state.cursor.evm?.skip ?? 0)), state.config.k)
  if (evmResult.contested) evmWinner = 'contested'
  else if (evmResult.winner && evmResult.winner.view.src === 'evm') {
    const r = applyEvmView(state, evmResult.winner.view, now)
    state = r.state
    applied.push(...r.applied)
    evmWinner = `${evmResult.winner.hash.slice(0, 8)}×${evmResult.winner.votes} → block ${evmResult.winner.view.to} (${evmResult.winner.view.events.length} events)`
  }
  const ticked = tick(state, now)
  state = ticked.state
  applied.push(...ticked.applied)

  const written = saveState(state)

  // Node-local: take in peers' signatures for what is pending now, sign anything new, submit what has k.
  const ingested = ingestSignatures(state, sigCache, heardSigs)
  mySignatures(state, keys, sigCache)
  const submissions = await submitReady(state, sigCache, ctx.lclSeqNo)
  persistSigs(sigCache, state)
  for (const note of submissions) applied.push({ kind: 'submit', detail: note })
  const attIngested = await ingestAttestations(state, attCache, heardAtt)
  await myAttestations(state, keys, attCache)
  const relays = await relayReady(state, keys, attCache, ctx.lclSeqNo)
  persistAttestations(attCache, state)
  for (const note of relays) applied.push({ kind: 'relay', detail: note })
  const summary = {
    lcl: ctx.lclSeqNo,
    heard: `${heard}/${Math.max(0, ctx.unl.count() - 1)}`,
    timedOut,
    myView: (() => {
      const v = views.find((x): x is Extract<View, { src: 'xrpl' }> => x.src === 'xrpl')
      return v ? `${v.from}→${v.to} (${v.events.length})` : null
    })(),
    counts: result.counts,
    winner: winner ?? null,
    evmWinner: evmWinner ?? null,
    keysHeard: heardKeys.length,
    sigsIn: heardSigs.length,
    sigsIngested: ingested,
    attIn: heardAtt.length,
    attIngested,
    applied: applied.map((a) => `${a.kind}: ${a.detail}`),
    written,
    ms: Date.now() - started,
    stateHash: stateHash(state).slice(0, 12),
  }
  try {
    fs.writeFileSync(LAST_ROUND_FILE, JSON.stringify(summary))
  } catch {
    /* node-local only */
  }
  if (applied.length || views.some((v) => v.src === 'xrpl' && v.events.length) || timedOut || ctx.lclSeqNo % 30 === 0) log(`round ${JSON.stringify(summary)}`)
}

// A rejection nobody awaits (a peer-message callback, a late timer) must not end the process mid-round: Node's default is to throw, and the node would leave without voting or saving.
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${(e as Error)?.message ?? String(e)}`))

