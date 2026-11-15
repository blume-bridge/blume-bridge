/**
 * How far a chain read is known to be whole. Both feeds cache a span that is
 * wider than the window; a span is only good up to the last position the
 * answering server actually held, so the cursor never runs past history a
 * node has not seen.
 */

/**
 * Last ledger, at most `spanTo`, a paged account_tx read covers whole.
 * `searchedMax` is the newest ledger the server reports having searched
 * (api_version 2 answers with it, and refuses ranges it lacks outright).
 */
export function xrplCoverage(spanTo: number, complete: boolean, lastLedger: number, searchedMax: number | null): number {
  const paged = complete ? spanTo : lastLedger - 1
  return searchedMax === null ? paged : Math.min(paged, searchedMax)
}

/** Last block, at most `spanTo`, a log read covers whole, given the head of the node that answered it. */
export function evmCoverage(spanTo: number, headOnClient: number, confirmations: number): number {
  return Math.min(spanTo, headOnClient - confirmations)
}
