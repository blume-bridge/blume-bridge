/**
 * Has a freshly started cluster formed, or is it only that every instance runs the app? The creation of 2026-10-18 on the
 * final hosts printed "cluster created" because each instance answered a code read with the right hash, while the cluster had
 * stopped at ledger 133 with one node a ledger behind and every node reporting `unreliable` (docs/DESIGN.md,
 * Decision 39). Formed means: every instance runs the built app, its UNL is the whole cluster, it is `synced`, its ledger moves
 * and the ledgers of the nodes are within a couple of each other. Pure: the reads are in scripts/lib/cluster-client.ts.
 */

/** What HotPocket answers to a status request (hotpocket-js-client `getStatus`). */
export interface HpStatus {
  ledgerSeqNo: number
  voteStatus: string
  weaklyConnected?: boolean
  currentUnl: string[]
  peers: string[]
}

/** One look at one node. `null` where a read failed. */
export interface NodeSample {
  /** `host:port`, as the messages name it. */
  node: string
  code: { loaded: string; appHash: string | null } | null
  status: HpStatus | null
}

export interface FormationOptions {
  /** SHA-256 of the app that was bundled. */
  appHash: string
  /** The number of nodes in the cluster. */
  unl: number
  /** How long, in milliseconds, between the two looks. */
  gapMs: number
}

/** The most ledgers that two nodes may be apart when read a moment apart. */
export const MAX_LEDGER_SPREAD = 2

/** Problems found by two looks at every node; empty when the cluster has formed. */
export function formationProblems(first: NodeSample[], second: NodeSample[], opts: FormationOptions): string[] {
  if (first.length !== second.length) throw new Error('both looks must cover the same nodes')
  const out: string[] = []
  // A ledger every 6 s is what the first rehearsal's cluster does at a round time of 3 s, so a window of 9 to 14 s must show one.
  const advance = Math.max(1, Math.floor(opts.gapMs / 7000))
  second.forEach((now, i) => {
    const name = now.node
    if (!now.code) return void out.push(`${name}: cannot be read`)
    if (now.code.loaded !== 'app') out.push(`${name}: runs ${now.code.loaded}, not the app`)
    else if (now.code.appHash !== opts.appHash) out.push(`${name}: runs app ${String(now.code.appHash).slice(0, 12)}, not the one that was built (${opts.appHash.slice(0, 12)})`)
    const st = now.status
    if (!st) return void out.push(`${name}: gives no HotPocket status`)
    if (st.currentUnl.length !== opts.unl) out.push(`${name}: its UNL has ${st.currentUnl.length} key(s), not ${opts.unl}: the bundle's configuration has not reached it`)
    if (st.voteStatus !== 'synced') out.push(`${name}: ${st.voteStatus}, not synced`)
    const before = first[i].status
    if (before && st.ledgerSeqNo - before.ledgerSeqNo < advance) out.push(`${name}: ledger ${before.ledgerSeqNo} to ${st.ledgerSeqNo} in ${Math.round(opts.gapMs / 1000)} s: it is not closing ledgers`)
  })
  const ledgers = second.flatMap((s) => (s.status ? [s.status.ledgerSeqNo] : []))
  if (ledgers.length > 1 && Math.max(...ledgers) - Math.min(...ledgers) > MAX_LEDGER_SPREAD) {
    out.push(`the nodes are at different ledgers: ${second.map((s) => `${s.node} ${s.status ? s.status.ledgerSeqNo : '?'}`).join(', ')}`)
  }
  return out
}

/** One line per node, for a report: ledger, vote status, UNL size, peers. */
export function describeSamples(samples: NodeSample[]): string {
  return samples
    .map((s) => {
      const st = s.status
      const code = s.code ? `${s.code.loaded} ${String(s.code.appHash).slice(0, 12)}` : 'no code read'
      return st ? `  ${s.node.padEnd(44)} ledger ${st.ledgerSeqNo}  ${st.voteStatus.padEnd(10)} unl ${st.currentUnl.length}  peers ${st.peers.length}  ${code}` : `  ${s.node.padEnd(44)} no status  ${code}`
    })
    .join('\n')
}
