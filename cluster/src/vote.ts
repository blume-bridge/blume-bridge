import { cmpStr, hashOf } from './canon'
import { log } from './log'
import type { AttestMessage, OperatorKeys, SigMessage, View } from './types'

/**
 * The NPL round message and the view vote. Each round every node sends one
 * message: the views it proposes (its ledger window, and the full key set
 * once it has heard every node), its own public keys while the operator set
 * is still forming, and its signatures for pending actions. State moves only
 * on k byte-identical views. NPL is a side channel HotPocket does not
 * consense, so what a node collected can differ from its peers; the tally is
 * deterministic over the votes a node holds, a node that holds fewer than k
 * applies nothing and tries again next round, and HotPocket resyncs a node
 * that falls behind the majority.
 */

export interface ViewVote {
  node: string
  src: View['src']
  hash: string
  view: View
}

export interface Tally {
  winner?: { hash: string; view: View; votes: number }
  counts: Record<string, number>
  /** Two different views each reached k. Nothing is applied: with k <= n/2 that can happen honestly, and a hash tie-break is not agreement. */
  contested?: boolean
}

export function tally(votes: ViewVote[], k: number): Tally {
  const byHash = new Map<string, { view: View; nodes: Set<string> }>()
  for (const v of votes) {
    const entry = byHash.get(v.hash) ?? { view: v.view, nodes: new Set<string>() }
    entry.nodes.add(v.node)
    byHash.set(v.hash, entry)
  }
  const counts: Record<string, number> = {}
  let winner: Tally['winner']
  let contested = false
  for (const [hash, { view, nodes }] of [...byHash.entries()].sort(([a], [b]) => cmpStr(a, b))) {
    counts[hash] = nodes.size
    if (nodes.size < k) continue
    if (winner) contested = true
    if (!winner || nodes.size > winner.votes) winner = { hash, view, votes: nodes.size }
  }
  return contested ? { counts, contested } : { winner, counts }
}

/** Most entries one peer message may carry in any list (views, signatures, attestations). Honest messages hold a handful; this bounds the work a hostile one can cause. */
const WIRE_MAX_ITEMS = 256

/** A list from a peer message: an array, cut to WIRE_MAX_ITEMS, or nothing at all when it is not an array. */
function wireItems(v: unknown): unknown[] {
  return Array.isArray(v) ? v.slice(0, WIRE_MAX_ITEMS) : []
}

/** Bytes one round message may carry (HotPocket's limit is 128 KiB; this leaves room); above it signatures are trimmed before views are dropped. */
const WIRE_LIMIT = 120_000
const WIRE_KEEP_SIGS = 40
const byteLength = (s: string) => Buffer.byteLength(s)

interface WireMessage {
  t: 'round'
  r: number
  views: { src: View['src']; hash: string; view: View }[]
  keys?: OperatorKeys
  sigs?: SigMessage[]
  att?: AttestMessage[]
}

export interface RoundPayload {
  views: View[]
  keys?: OperatorKeys
  sigs?: SigMessage[]
  att?: AttestMessage[]
}

export interface Collected {
  votes: ViewVote[]
  keys: OperatorKeys[]
  sigs: { node: string; sig: SigMessage }[]
  att: { node: string; att: AttestMessage }[]
  heard: number
  timedOut: boolean
}

/** What a peer may spend after the round starts before its message is sent, besides its views: loading state, inputs, signatures, and the gap between two nodes starting the same round. */
export const VOTE_SLACK_MS = 1000

/**
 * How long to wait for the other nodes' votes, counted from now. At least `voteTimeoutMs` (half a round), and long
 * enough that a peer whose views take the whole `viewBudgetMs` is still heard: the deadline is set from the round's
 * start, not from this node's own send, so a fast node does not stop listening before a slow one has spoken. A round
 * in which every peer answers ends as soon as the last one does; only a node that is down costs the full wait.
 */
export function voteWaitMs(startedAt: number, now: number, voteTimeoutMs: number, viewBudgetMs: number): number {
  return Math.max(voteTimeoutMs, startedAt + viewBudgetMs + VOTE_SLACK_MS - now)
}

interface Ctx {
  publicKey: string
  unl: { onMessage(cb: (node: { publicKey: string }, msg: Buffer) => void): void; send(msg: string): Promise<void>; count(): number }
}

/**
 * Registers the single NPL handler (HotPocket allows one) and returns a
 * collector. Call `send` with this node's payload, then `collect` to wait for
 * the others. Messages from other rounds and from this node are ignored.
 */
export function startCollector(ctx: Ctx, round: number) {
  const votes: ViewVote[] = []
  const keys: OperatorKeys[] = []
  const sigs: { node: string; sig: SigMessage }[] = []
  const att: { node: string; att: AttestMessage }[] = []
  const nodesHeard = new Set<string>()
  let notify: (() => void) | null = null

  /** One peer's round message. Everything in it is untrusted: a node with a bad key, a bug or a hostile operator can send anything. */
  const onPeer = (node: { publicKey: string }, raw: Buffer) => {
    if (node.publicKey === ctx.publicKey) return
    let msg: WireMessage
    try {
      msg = JSON.parse(raw.toString()) as WireMessage
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null || msg.t !== 'round' || msg.r !== round) return
    if (nodesHeard.has(node.publicKey)) return
    nodesHeard.add(node.publicKey)
    // One view per source per node. A message voting twice for one source is taken for nothing (it still counts as heard, so honest nodes do not wait out the timeout).
    const views = wireItems(msg.views)
    const srcs = views.map((v) => (v as { src?: unknown } | null)?.src)
    if (new Set(srcs).size !== srcs.length) {
      log(`vote: ${node.publicKey.slice(0, 8)} sent more than one view for a source; ignoring its message`)
      notify?.()
      return
    }
    for (const v of views as WireMessage['views']) {
      if (!v?.view || typeof v.view !== 'object' || typeof v.hash !== 'string' || hashOf(v.view) !== v.hash) continue
      votes.push({ node: node.publicKey, src: v.src, hash: v.hash, view: v.view })
    }
    const keysMsg = msg.keys
    if (keysMsg && typeof keysMsg === 'object' && keysMsg.node === node.publicKey && typeof keysMsg.xrplAddress === 'string' && typeof keysMsg.evmAddress === 'string') keys.push(keysMsg)
    for (const s of wireItems(msg.sigs) as SigMessage[]) if (s && typeof s.a === 'string' && s.s?.Signer?.Account) sigs.push({ node: node.publicKey, sig: s })
    for (const a of wireItems(msg.att) as AttestMessage[]) if (a && typeof a.a === 'string' && typeof a.e === 'string' && typeof a.s === 'string') att.push({ node: node.publicKey, att: a })
    notify?.()
  }

  // The handler HotPocket calls must never throw: the library runs it outside the contract's own promise chain, so a throw is an unhandled rejection that ends the process on every honest node for the rest of the round.
  ctx.unl.onMessage((node, raw) => {
    try {
      onPeer(node, raw)
    } catch (e) {
      log(`vote: a message from ${String(node?.publicKey).slice(0, 8)} could not be read (${(e as Error).message}); ignoring it`)
      notify?.()
    }
  })

  return {
    async send(payload: RoundPayload): Promise<ViewVote[]> {
      const mine = payload.views.map((view) => ({ src: view.src, hash: hashOf(view), view }))
      const msg: WireMessage = { t: 'round', r: round, views: mine, keys: payload.keys, sigs: payload.sigs?.length ? payload.sigs : undefined, att: payload.att?.length ? payload.att : undefined }
      // HotPocket refuses a message over its byte limit by throwing, which would end the round on this node. Measure bytes (a memo's U+FFFD is one character and three bytes), and send what fits.
      let wire = JSON.stringify(msg)
      let sent = mine
      if (byteLength(wire) > WIRE_LIMIT) {
        // Views are what moves state; signatures re-send every round anyway. Trim those first (the oldest pending go out), drop them entirely next, and only then the views.
        const full = byteLength(wire)
        const trimmed: WireMessage = { ...msg, sigs: msg.sigs?.slice(0, WIRE_KEEP_SIGS), att: msg.att?.slice(0, WIRE_KEEP_SIGS) }
        const bare: WireMessage = { ...msg, sigs: undefined, att: undefined }
        if (byteLength(JSON.stringify(trimmed)) <= WIRE_LIMIT) {
          wire = JSON.stringify(trimmed)
          log(`vote: own message ${full} bytes, sent ${byteLength(wire)} with signatures trimmed (${msg.sigs?.length ?? 0} sigs, ${msg.att?.length ?? 0} att)`)
        } else if (byteLength(JSON.stringify(bare)) <= WIRE_LIMIT) {
          wire = JSON.stringify(bare)
          log(`vote: own message ${full} bytes, sent ${byteLength(wire)} without signatures`)
        } else {
          // Even the views alone are too big. Keep the ones that fit, smallest first, so one oversized source cannot silence the others.
          const empty = byteLength(JSON.stringify({ ...bare, views: [] }))
          const bySize = mine.map((m, i) => ({ i, bytes: byteLength(JSON.stringify(m)) + 1 })).sort((a, b) => a.bytes - b.bytes || a.i - b.i)
          const keep = new Set<number>()
          let used = empty
          for (const m of bySize) {
            if (used + m.bytes > WIRE_LIMIT) continue
            used += m.bytes
            keep.add(m.i)
          }
          sent = mine.filter((_, i) => keep.has(i))
          wire = JSON.stringify({ ...bare, views: sent })
          log(`vote: own message ${full} bytes even without signatures; sent ${sent.length} of ${mine.length} views (${sent.map((m) => m.src).join(',') || 'none'}), ${byteLength(wire)} bytes`)
        }
      }
      try {
        await ctx.unl.send(wire)
      } catch (e) {
        // Never let a send end the round: say so, and send the smallest message that still tells the others this node is here.
        log(`vote: could not send ${byteLength(wire)} bytes (${(e as Error).message}); sending an empty message`)
        sent = []
        await ctx.unl.send(JSON.stringify({ t: 'round', r: round, views: [] } satisfies WireMessage)).catch(() => undefined)
      }
      return sent.map((m) => ({ node: ctx.publicKey, ...m }))
    },
    collect(expectedOthers: number, timeoutMs: number): Promise<Collected> {
      return new Promise((resolve) => {
        const finish = (timedOut: boolean) => {
          clearTimeout(timer)
          notify = null
          resolve({ votes: [...votes], keys: [...keys], sigs: [...sigs], att: [...att], heard: nodesHeard.size, timedOut })
        }
        const timer = setTimeout(() => finish(true), timeoutMs)
        notify = () => {
          if (nodesHeard.size >= expectedOthers) finish(false)
        }
        if (nodesHeard.size >= expectedOthers) finish(false)
      })
    },
  }
}
