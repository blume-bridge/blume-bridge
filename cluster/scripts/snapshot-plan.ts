/**
 * The decisions snapshot-state.ts makes, with no file or network access so they can be tested: which nodes' state
 * is the cluster's state, and how many nodes there are. Nothing here knows how many nodes a cluster has; n comes from
 * the config and the directories that were pulled.
 */
import { createHash } from 'node:crypto'

export interface PulledNode {
  n: number
  /** One digest over the node's state files: names and exact bytes. */
  digest: string
}

/** One digest for a node's state directory. Consensus state is byte-identical on every node that is in step, so equal digests mean equal state. */
export function digestOf(files: Record<string, Buffer | string>): string {
  const h = createHash('sha256')
  for (const name of Object.keys(files).sort()) {
    h.update(`${name}\0`)
    h.update(createHash('sha256').update(files[name]).digest())
  }
  return h.digest('hex')
}

/** The node numbers present in a pulled stage, from its directory names: node1, node2, ... Anything else is ignored. */
export function nodeNumbers(entries: string[]): number[] {
  return entries
    .map((e) => /^node([1-9][0-9]*)$/.exec(e))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
}

/**
 * How many nodes the snapshot is of: CLUSTER_SIZE when given, else however many node directories were pulled. They
 * must be exactly node1..nodeN, with none missing and none extra.
 */
export function expectedNodes(entries: string[], clusterSize: string | undefined): number[] {
  const found = nodeNumbers(entries)
  const n = clusterSize ? Number(clusterSize) : found.length
  if (!Number.isInteger(n) || n < 1) throw new Error(clusterSize ? `CLUSTER_SIZE must be a positive integer, got '${clusterSize}'` : 'no node directories were pulled')
  const want = Array.from({ length: n }, (_, i) => i + 1)
  const missing = want.filter((x) => !found.includes(x))
  const extra = found.filter((x) => !want.includes(x))
  if (missing.length) throw new Error(`the snapshot is for ${n} node(s) but node ${missing.join(', ')} was not pulled`)
  if (extra.length) throw new Error(`the snapshot is for ${n} node(s) but node ${extra.join(', ')} was pulled as well: CLUSTER_SIZE is wrong or the pull saw another cluster`)
  return want
}

/**
 * SNAPSHOT_MIN_AGREE: how many nodes must hold the same state. Default every node. It may be lowered when a node is
 * lost, but never below k: a state fewer than k nodes hold is not one the cluster could have agreed on.
 */
export function minAgreeFrom(raw: string | undefined, nodeCount: number, k: number): number {
  if (raw === undefined || raw === '') return nodeCount
  const v = Number(raw)
  if (!Number.isInteger(v) || v < 1) throw new Error(`SNAPSHOT_MIN_AGREE must be a positive integer, got '${raw}'`)
  if (v > nodeCount) throw new Error(`SNAPSHOT_MIN_AGREE=${v} but only ${nodeCount} node(s) were pulled`)
  if (v < k) throw new Error(`SNAPSHOT_MIN_AGREE=${v} is below k=${k}: a state fewer than k nodes hold is not one the cluster could have agreed on`)
  return v
}

/**
 * Which nodes' state to take. The largest group of nodes with identical state wins if it has at least `minAgree`
 * members and no other group is as large; everyone else is named as dissenting.
 */
export function chooseSnapshot(nodes: PulledNode[], minAgree: number): { chosen: number[]; dissent: number[]; digest: string } {
  const groups = new Map<string, number[]>()
  for (const { n, digest } of nodes) groups.set(digest, [...(groups.get(digest) ?? []), n])
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[1][0] - b[1][0])
  const [digest, chosen] = ranked[0]
  if (chosen.length < minAgree) {
    if (minAgree === nodes.length) throw new Error(`the nodes disagree (${ranked.map(([, g]) => `node ${g.join('+')}`).join(' vs ')}); not writing a snapshot from a split cluster. If a node is lost, set SNAPSHOT_MIN_AGREE to how many agree.`)
    throw new Error(`only ${chosen.length} node(s) agree (node ${chosen.join(', ')}) and SNAPSHOT_MIN_AGREE is ${minAgree}; not writing a snapshot`)
  }
  if (ranked.length > 1 && ranked[1][1].length === chosen.length) throw new Error(`two groups of ${chosen.length} node(s) disagree (${ranked.map(([, g]) => `node ${g.join('+')}`).join(' vs ')}); there is no majority to take the state from`)
  return { chosen, dissent: nodes.map((x) => x.n).filter((x) => !chosen.includes(x)), digest }
}

/**
 * A state backup generation against the manifest written beside it: every file the manifest names is there with the
 * recorded hash, and there is no state file the manifest does not know. Empty means it matches.
 */
export function verifyManifest(files: Record<string, Buffer | string>, manifest: { files?: Record<string, string> } | null | undefined): string[] {
  const problems: string[] = []
  const listed = manifest?.files
  if (!listed || typeof listed !== 'object' || !Object.keys(listed).length) return ['the manifest lists no files']
  for (const [name, hash] of Object.entries(listed)) {
    const file = files[name]
    if (file === undefined) problems.push(`${name} is in the manifest but not in the copy`)
    else if (createHash('sha256').update(file).digest('hex') !== hash) problems.push(`${name} does not match its recorded hash`)
  }
  for (const name of Object.keys(files)) if (name !== 'MANIFEST.json' && !(name in listed)) problems.push(`${name} is in the copy but not in the manifest`)
  return problems
}
