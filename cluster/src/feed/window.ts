/**
 * Cuts a window so that a view stays small enough to vote on, without ever
 * leaving an event out. `events` is sorted by position, starts after the
 * cursor (and after the `skip` events of the first position already applied),
 * and lies entirely at or before `to`.
 *
 * A view is bounded two ways: by event count (`cap`, which paces rounds) and by
 * serialised bytes (`bytes`, which keeps the round message under the NPL limit
 * whatever the events carry). When everything fits the window is unchanged.
 * Otherwise it ends at the last position whose events still fit, and the
 * positions after it wait for the next window.
 *
 * When the FIRST position alone does not fit (a ledger or a block somebody
 * flooded), the view carries as many of its events as fit, at least one, and
 * the cursor does not move: `partial` is true and `to` is `from`. The machine
 * records how many events of that position are applied (the cursor's `skip`),
 * and the next window starts after them, so a position of any size is worked
 * through a view at a time. Dropping an event is the one thing a feed must
 * never do: a dropped outgoing payment lets its action expire and re-queue at
 * the next sequence, which is a second release of the same transfer.
 */
export interface WindowBounds<E> {
  /** The cursor before this window. */
  from: number
  /** The last position the window may reach. */
  to: number
  /** Most events in one view. */
  cap: number
  /** Most serialised bytes of events in one view. */
  bytes: number
  pos: (e: E) => number
  size: (e: E) => number
}

export interface CutWindow<E> {
  to: number
  events: E[]
  cut: boolean
  /** Only part of the first position is in `events`; the cursor stays where it is. */
  partial: boolean
}

export function cutWindow<E>(events: E[], b: WindowBounds<E>): CutWindow<E> {
  const sizes = events.map(b.size)
  if (events.length <= b.cap && sizes.reduce((n, x) => n + x, 0) <= b.bytes) return { to: b.to, events, cut: false, partial: false }
  let end = 0 // events[0..end) are whole positions that fit
  let used = 0
  for (let i = 0; i < events.length; i++) {
    used += sizes[i]
    if (i + 1 > b.cap || used > b.bytes) break
    const lastOfPosition = i + 1 === events.length || b.pos(events[i + 1]) !== b.pos(events[i])
    if (lastOfPosition) end = i + 1
  }
  if (end > 0) {
    const kept = events.slice(0, end)
    return { to: b.pos(kept[kept.length - 1]), events: kept, cut: true, partial: false }
  }
  // The first position does not fit whole: a prefix of it, never fewer than one event, and the cursor stays.
  const first = b.pos(events[0])
  let n = 0
  used = 0
  while (n < events.length && b.pos(events[n]) === first && n < b.cap && (n === 0 || used + sizes[n] <= b.bytes)) {
    used += sizes[n]
    n++
  }
  return { to: b.from, events: events.slice(0, n), cut: true, partial: true }
}

/** What an event costs on the wire: its JSON in UTF-8 bytes, not characters (a memo's U+FFFD is one character and three bytes). */
export function eventBytes(e: unknown): number {
  return Buffer.byteLength(JSON.stringify(e))
}

/** Bytes of events one view may carry from the XRP Ledger, and from XRPL EVM. Together with the accounts, issuers and listings a view adds, and the signatures a round message carries, both fit under the NPL limit (vote.ts). */
export const XRPL_VIEW_BYTES = 40_000
export const EVM_VIEW_BYTES = 30_000
