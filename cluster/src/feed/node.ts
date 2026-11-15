import { sha256 } from '../canon'

/**
 * Which server a node reads from first.
 *
 * Every node used to try the same servers in the same order, so a server that lied was believed by all of them at once, and
 * the lie reached k. A node now starts its list at a point of its own, chosen by its HotPocket public key: with several
 * servers the nodes spread across them, and a view built from one liar's answers stands alone against the others'. The
 * cluster stops (no view reaches k) instead of believing it. A server that is down just means the next one is used.
 *
 * Node-local and not consensus: it changes where this node asks, never what the agreed state is. Off (`rotate: false` in
 * the config) when the operator's own servers lead the list, because then the order is the point.
 */
let nodeId = ''
let rotation = { xrpl: true, evm: true }

/** Called once per round with this node's public key and the config's switches. */
export function configureNode(id: string, rotate: { xrpl: boolean; evm: boolean }): void {
  nodeId = id
  rotation = rotate
}

export function rotated<T>(list: readonly T[], chain: 'xrpl' | 'evm'): T[] {
  if (!rotation[chain] || !nodeId || list.length < 2) return [...list]
  const offset = parseInt(sha256(nodeId).slice(0, 8), 16) % list.length
  return [...list.slice(offset), ...list.slice(0, offset)]
}
