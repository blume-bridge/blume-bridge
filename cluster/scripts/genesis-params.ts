/**
 * The genesis `params` block, in one place. Both generators (testnet-setup.ts
 * for the test ledgers, mainnet-genesis.ts for the sole-operator cluster) read
 * it from here, so a new option cannot land on one network and silently go
 * missing on the other, which is how genesis/testnet.json ended up without
 * feeXrp and payout.
 *
 * Every fee is XRP, flat, and nothing is ever taken from the bridged token
 * (docs/DESIGN.md, Fees). The two profiles differ in
 * their clocks and their caps, never in their fees, so what is rehearsed on the
 * test ledgers is what mainnet charges.
 */
import { isValidClassicAddress } from 'ripple-address-codec'
import type { Params } from '../src/types'

export type Profile = 'test' | 'production'

/**
 * k and n for a cluster, from the environment, and nothing else: the cluster's size is never assumed (it starts as
 * the operator's own nodes and widens), so there is no default. k signatures out of n operators, and k has to be a majority:
 * with 2k <= n two disjoint groups of k could each agree on a different view, or sign different releases.
 */
export function quorum(env: { K?: string; N?: string }): { k: number; n: number } {
  const need = (name: 'K' | 'N'): number => {
    const raw = env[name]?.trim()
    if (!raw) throw new Error(`${name} is required: the cluster's size is never assumed (K signatures out of N operators)`)
    if (!/^[1-9]\d{0,2}$/.test(raw)) throw new Error(`${name} must be a whole number of 1 or more, not ${JSON.stringify(raw)}`)
    return Number(raw)
  }
  const k = need('K')
  const n = need('N')
  if (k > n) throw new Error(`K=${k} cannot be more than N=${n}`)
  if (2 * k <= n) throw new Error(`K=${k} of N=${n} is not a majority: two groups of ${k} could sign different things`)
  return { k, n }
}

/** Servers from a comma list in the environment, put in front of the public defaults, each once. Their order is the order they are tried in. */
export function serversFirst(name: string, own: string | undefined, defaults: string[]): string[] {
  const mine = (own ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const url of mine) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`${name}: ${JSON.stringify(url)} is not a URL`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${name}: ${JSON.stringify(url)} must be http or https`)
  }
  return [...new Set([...mine, ...defaults])]
}

/** The treasury's XRPL address from the environment: optional (unset, its 30% stays in the funding account), never the lock account. */
export function treasuryFrom(raw: string | undefined, lock: string): string | undefined {
  const address = raw?.trim()
  if (!address) return undefined
  if (!isValidClassicAddress(address)) throw new Error(`TREASURY must be an XRPL r-address, not ${JSON.stringify(address)}`)
  if (address === lock) throw new Error('TREASURY must not be the lock account: the treasury share would be paid into the tokens that back the ERC-20s')
  return address
}

export function params(profile: Profile, overrides: { defaultCapUnits?: string; treasuryAccount?: string; operatorPayout?: string } = {}): Params {
  const test = profile === 'test'
  return {
    // 70% to the operators, 30% to the treasury, paid out daily in production.
    split: { operators: 70, treasury: 30 },
    // Bridging in: paid to the funding account with the lock's Batch, or before it. The only fee on the way in.
    feeXrp: '1',
    // A lock that never paid it can be taken back, by its sender, for this: it costs the cluster a multisigned return.
    returnFeeXrp: '0.25',
    // Listing a token: its issuer pays it, or anyone does for a token whose issuer is locked for good. Listed at once.
    issuerListingFeeXrp: '50',
    // What an issuer pays to change its token's name or logo.
    metaFeeXrp: '5',
    xrplFeeDrops: '1000',
    actionTtlLedgers: 400,
    // What the lock account's trust line takes, per token. A seed with no cap takes whatever is bridged, so the ledger's own limit must not be the
    // cap: PONGO's supply is about 1e14, a hundred times the 1e12 this used to be, and a deposit over the limit fails on the ledger.
    trustLineLimit: '1000000000000000',
    // What a new listing is put on the minter with. Production lists at 0: a token takes nothing until an operator sets a
    // cap. The cluster's own cap check turns every lock away at 0, so that holds whichever way the minter reads a cap of 0
    // (the v2 minter: unlimited; v3: no mints). Seeds keep the cap scripts/seed-build.ts priced offline. The test ledgers
    // take a working cap so a listing can be bridged the minute it exists.
    defaultCapUnits: overrides.defaultCapUnits ?? (test ? '100000' : '0'),
    // A refused release is retried every minute and given back after five, so the hold can be watched; 10 min / 24 h in production.
    releaseRetryMs: test ? 60000 : 600000,
    releaseHoldMs: test ? 300000 : 86400000,
    payout: {
      // Every 10 minutes on the test ledgers so a payout can be watched inside a session; daily in production.
      everyMs: test ? 600000 : 86400000,
      minXrp: test ? '0.5' : '5',
      minShareXrp: '1',
      // XRP the lock account keeps free above its reserve; each payout tops it up to this before the fees are split.
      lockFloorXrp: '10',
      // Where the treasury's 30% goes. Unset, it stays in the funding account (a payment to itself would fail a Batch at
      // preflight): the test ledgers have no treasury, mainnet-genesis.ts takes one from TREASURY.
      ...(overrides.treasuryAccount ? { treasuryAccount: overrides.treasuryAccount } : {}),
      // Where an operator that published no payout address is paid (src/payout.ts). The funding account itself holds the share there.
      ...(overrides.operatorPayout ? { operatorPayout: overrides.operatorPayout } : {}),
    },
  }
}

export interface RpcPolicy {
  /** Whether each node starts the XRP Ledger server list at a point of its own (src/feed/node.ts). False when the operator's own servers lead the list. */
  rotateXrpl: boolean
  rotateEvm: boolean
  notes: string[]
}

const hostsOf = (urls: string[]) => new Set(urls.map((u) => new URL(u).host)).size

/**
 * What the cluster believes about both ledgers comes from the servers it reads, and a server that lies is believed by
 * every node that asks it. Three things keep that from being one point of failure: the operator's own servers lead the
 * list (and are then used in order), or, with public servers only, each node starts at a different one so a liar's view
 * does not reach k; and there must be at least two independent servers to choose from. The XRP Ledger side has three
 * public ones; XRPL EVM has one, so booting on it alone has to be said out loud.
 */
export function rpcPolicy(env: { XRPL_RPC?: string; EVM_RPC?: string; ACCEPT_SINGLE_EVM_RPC?: string }, xrplRpcs: string[], evmRpcs: string[]): RpcPolicy {
  const ownXrpl = !!env.XRPL_RPC?.trim()
  const ownEvm = !!env.EVM_RPC?.trim()
  const notes: string[] = []
  if (hostsOf(xrplRpcs) < 2) throw new Error('XRPL_RPC: the XRP Ledger side needs at least two independent servers to read from, so that one liar cannot be believed by every node')
  if (hostsOf(evmRpcs) < 2) {
    if (env.ACCEPT_SINGLE_EVM_RPC !== '1') {
      throw new Error(
        'EVM_RPC: only one XRPL EVM server is configured, and whatever it says a burn is, every node believes: a forged Burn log would release real backing. ' +
          'Give EVM_RPC two or more independent servers (your own node first), or set ACCEPT_SINGLE_EVM_RPC=1 to boot on the one public server knowing the loss it allows is bounded by the caps (a burn above what is locked is refused).',
      )
    }
    notes.push('XRPL EVM is read from a single server (ACCEPT_SINGLE_EVM_RPC=1): a lying server could forge a Burn; the damage is bounded by the token caps and by the refusal of any burn above what is locked.')
  }
  if (!ownXrpl && !ownEvm) notes.push('Only public servers are configured: each node starts at a different one, so a single liar does not reach k. Your own servers (XRPL_RPC, EVM_RPC) are better.')
  return { rotateXrpl: !ownXrpl, rotateEvm: !ownEvm, notes }
}
