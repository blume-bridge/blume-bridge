/**
 * HotPocket closes a ledger only when a share of the UNL, `contract.consensus.threshold` percent (default 80), agrees. With three
 * nodes 80% needs all three, and so does the vote on which ledger is the last one: when one node is a ledger behind the other
 * two (it closed 132 while they closed 133), the two are 67% of the UNL, which is under 80%, so nobody can tell who is right,
 * nobody resyncs and nobody closes another ledger. The first Evernode cluster of 2026-10-18 on the final hosts stopped that
 * way, at ledger 133, 20 seconds after the bundle landed, and an instance cannot be restarted or repaired from outside.
 *
 * The threshold the cluster should run with is the one that makes k nodes enough: the signing quorum already says that k of n
 * nodes may act, so the ledger can be closed by k of n as well. That also keeps two groups from both having enough (k is more
 * than half of n), so there is nothing to fork.
 */

/**
 * The largest whole percent, from 51 to 99, for which n*p/100 lies strictly between k-1 and k. Strictly, so that the number of
 * nodes needed comes out as k whether HotPocket rounds the product up or takes its integer part plus one (they differ only
 * when the product is a whole number, e.g. 5 nodes at 60%). n=3 k=2 gives 66, n=5 k=3 gives 59.
 */
export function consensusPercent(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 1 || k < 1 || k > n) throw new Error(`n and k must be whole numbers with 1 <= k <= n, got n=${n} k=${k}`)
  for (let p = 99; p >= 51; p--) if ((k - 1) * 100 < n * p && n * p < k * 100) return p
  throw new Error(`no consensus threshold from 51 to 99 percent makes exactly ${k} of ${n} nodes enough: k must be more than half of n`)
}

/** The number of nodes HotPocket needs for a UNL of `unl` at `percent` (rounded up, the way HotPocket counts votes). */
export function nodesNeeded(unl: number, percent: number): number {
  return Math.ceil((unl * percent) / 100)
}
