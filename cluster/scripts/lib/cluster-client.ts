import HotPocket from 'hotpocket-js-client'
import type { HpStatus, NodeSample } from './formation'

/**
 * Talking to a running cluster's node as a HotPocket user: shared by scripts/upgrade.ts and scripts/evernode-spread.ts.
 * A `node` is `host:port`, a node's user port (an Evernode instance's `domain:user port`) or the front door.
 */

/** What a node's loader answers to {type:"code"} (src/loader-core.ts). */
export interface CodeRead {
  node?: string
  version: number | null
  hash: string | null
  appHash: string | null
  prevHash: string | null
  upgraders: string[]
  loaded: string
  error: string | null
  last: { id?: string; ok: boolean; op?: string; error?: string; by: string; at: number } | null
}

export async function connect(node: string, keys: unknown) {
  const client = await HotPocket.createClient([`wss://${node}`], keys)
  if (!(await client.connect())) throw new Error(`cannot connect to ${node}`)
  return client
}

/** HotPocket's own status of a node: ledger, vote status, UNL, peers. A status request needs no key worth keeping either. */
export async function readStatus(node: string): Promise<HpStatus> {
  const client = await connect(node, await HotPocket.generateKeys())
  try {
    const st = (await client.getStatus()) as Partial<HpStatus> | null
    if (!st || typeof st.ledgerSeqNo !== 'number' || !Array.isArray(st.currentUnl)) throw new Error(`${node} did not answer a status request: ${JSON.stringify(st).slice(0, 120)}`)
    return { ledgerSeqNo: st.ledgerSeqNo, voteStatus: String(st.voteStatus), weaklyConnected: st.weaklyConnected, currentUnl: st.currentUnl, peers: st.peers ?? [] }
  } finally {
    await client.close()
  }
}

/** One look at a node: what its loader runs and what HotPocket says of it. A read that fails is `null`, not an error. */
export async function sampleNode(node: string): Promise<NodeSample> {
  const [code, status] = await Promise.all([readCode(node).catch(() => null), readStatus(node).catch(() => null)])
  return { node, code: code && { loaded: code.loaded, appHash: code.appHash }, status }
}

/** A read request needs no key worth keeping: a fresh one is made for it. */
export async function readCode(node: string): Promise<CodeRead> {
  const client = await connect(node, await HotPocket.generateKeys())
  try {
    const answer = (await client.submitContractReadRequest(JSON.stringify({ type: 'code', id: `code-${Date.now()}` }))) as CodeRead & { type?: string }
    if (answer?.type !== 'code') throw new Error(`${node} did not answer a code read (is it running the loader? ${JSON.stringify(answer).slice(0, 120)})`)
    return answer
  } finally {
    await client.close()
  }
}
