/**
 * Which XRP Ledger the scripts talk to, and where that network's files live.
 *
 * XRPL_NETWORK is the only input. There is deliberately no endpoint override:
 * xrpl.js picks its faucet from the *connected* server, so an XRPL_WS that
 * disagreed with XRPL_NETWORK funded accounts on one ledger, saved them to the
 * other one's key file and wrote a genesis naming accounts that do not exist.
 * One name now picks the WebSocket, the JSON-RPC list the genesis carries, the
 * explorer and the faucet together.
 *
 * No `xrpl` import here on purpose: scripts/testnet-evm.ts is viem-only and
 * still needs the genesis path.
 */
import path from 'node:path'

export interface XrplNetwork {
  label: string
  ws: string
  /** JSON-RPC endpoints the cluster reads from, tried in order; written into the genesis. */
  rpc: string[]
  explorer: string
  /** Whether client.fundWallet() can make accounts here. Mainnet is real money, so no. */
  faucet: boolean
}

export const NETWORKS = {
  devnet: {
    label: 'XRPL Devnet',
    ws: 'wss://s.devnet.rippletest.net:51233/',
    rpc: ['https://s.devnet.rippletest.net:51234/', 'https://clio.devnet.rippletest.net:51234/'],
    explorer: 'https://devnet.xrpl.org',
    faucet: true,
  },
  testnet: {
    label: 'XRPL Testnet',
    ws: 'wss://s.altnet.rippletest.net:51233',
    rpc: ['https://testnet.xrpl-labs.com/', 'https://s.altnet.rippletest.net:51234/'],
    explorer: 'https://testnet.xrpl.org',
    faucet: true,
  },
  mainnet: {
    label: 'XRP Ledger',
    ws: 'wss://xrplcluster.com',
    rpc: ['https://xrplcluster.com/', 'https://s1.ripple.com:51234/', 'https://s2.ripple.com:51234/'],
    explorer: 'https://livenet.xrpl.org',
    faucet: false,
  },
} satisfies Record<string, XrplNetwork>

export type NetworkName = keyof typeof NETWORKS

/** Batch is live on Devnet and on neither of the other two, so the cluster's XRP Ledger side runs there. */
export const DEFAULT_NETWORK: NetworkName = 'devnet'

/**
 * Unset, empty or whitespace is the default; anything else must name a table
 * entry. Called from inside each script's main() so a typo prints that script's
 * ERROR line instead of an import-time stack trace.
 */
export function pickNetwork(raw: string | undefined = process.env.XRPL_NETWORK): NetworkName {
  const name = raw?.trim() || DEFAULT_NETWORK
  if (!Object.hasOwn(NETWORKS, name)) throw new Error(`XRPL_NETWORK=${name}: expected one of ${Object.keys(NETWORKS).join(', ')}`)
  return name as NetworkName
}

/** One JSON-RPC call against a network's endpoints, in order, the first answer wins. Read-only callers only. */
export async function jsonRpc<T = any>(name: NetworkName, method: string, params: Record<string, unknown>): Promise<T> {
  const errors: string[] = []
  for (const url of NETWORKS[name].rpc) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [{ api_version: 2, ...params }] }) })
      const body = (await res.json()) as { result?: T & { status?: string; error?: string } }
      if (!body.result || body.result.status === 'error') throw new Error(body.result?.error ?? 'empty result')
      return body.result
    } catch (e) {
      errors.push(`${new URL(url).host}: ${(e as Error).message}`)
      // The account or pool does not exist: every server will say so, and asking the next one only repeats it.
      if (/actNotFound|entryNotFound|objectNotFound/.test((e as Error).message)) break
    }
  }
  throw new Error(`${method} failed: ${errors.join('; ')}`)
}

/** The package root, which is what every default and every relative override resolves against. */
const PKG_DIR = path.join(__dirname, '..')

export function genesisPathFor(name: NetworkName): string {
  return path.join(PKG_DIR, 'genesis', `${name}.json`)
}

/**
 * A relative KEYS_PATH resolves against the package, not the caller's cwd: run
 * from the monorepo root it would otherwise write seeds to <repo>/keys/, which
 * only cluster/.gitignore covers.
 */
export function keysPathFor(name: NetworkName): string {
  const override = process.env.KEYS_PATH?.trim()
  return override ? path.resolve(PKG_DIR, override) : path.join(PKG_DIR, 'keys', `${name}.json`)
}
