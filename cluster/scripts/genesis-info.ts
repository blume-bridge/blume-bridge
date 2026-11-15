/**
 * What a genesis says about the cluster it boots: how many nodes (n), how many
 * signatures (k) and whether it points at mainnet. The ops scripts read n from
 * here instead of assuming three nodes, and the key-safety rules (a fresh
 * mainnet cluster must be said out loud, a mainnet cluster is never destroyed
 * by accident) use the network answer.
 *
 *   npx tsx scripts/genesis-info.ts genesis/mainnet.json            # n=5 k=3 network=mainnet
 *   npx tsx scripts/genesis-info.ts genesis/mainnet.json n          # 5
 *   npx tsx scripts/genesis-info.ts genesis/mainnet.json network    # mainnet | other
 *   npx tsx scripts/genesis-info.ts genesis/mainnet.json consensus  # 59: the HotPocket threshold (percent) at which k of n nodes close a ledger
 *
 * Takes a genesis ({ config, tokens, ... }) or a bare config.json as a node
 * keeps it in its state directory. Reads one file, touches nothing else.
 */
import fs from 'node:fs'
import { consensusPercent } from './lib/consensus'
import { NETWORKS } from './network'

export const MAINNET_EVM_CHAIN_ID = 1440000

export interface GenesisInfo {
  n: number
  k: number
  network: 'mainnet' | 'other'
  /** What made it read as mainnet, for the message that refuses something. */
  why: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Hosts of the public mainnet XRPL endpoints in scripts/network.ts: a config that reads from one of them is real money. */
const MAINNET_HOSTS = new Set(NETWORKS.mainnet.rpc.map((u) => new URL(u).host))

export function genesisInfo(doc: unknown): GenesisInfo {
  const root = isObj(doc) ? doc : {}
  const config = isObj(root.config) ? root.config : root
  const { n, k } = config
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new Error(`config.n must be a positive integer, got ${JSON.stringify(n)}`)
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > n) throw new Error(`config.k must be an integer from 1 to n (${n}), got ${JSON.stringify(k)}`)
  const why: string[] = []
  const evm = isObj(config.evm) ? config.evm : {}
  if (evm.chainId === MAINNET_EVM_CHAIN_ID) why.push(`EVM chain id ${MAINNET_EVM_CHAIN_ID}`)
  const xrpl = isObj(config.xrpl) ? config.xrpl : {}
  for (const url of Array.isArray(xrpl.rpc) ? xrpl.rpc : []) {
    try {
      const host = new URL(String(url)).host
      if (MAINNET_HOSTS.has(host)) why.push(`XRPL RPC ${host}`)
    } catch {
      /* not a URL: not evidence of anything */
    }
  }
  return { n, k, network: why.length ? 'mainnet' : 'other', why }
}

function main() {
  const [file, field] = process.argv.slice(2)
  if (!file) throw new Error('usage: genesis-info.ts <genesis file> [n|k|network|consensus]')
  const info = genesisInfo(JSON.parse(fs.readFileSync(file, 'utf8')))
  if (field === undefined) console.log(`n=${info.n} k=${info.k} network=${info.network}`)
  else if (field === 'n' || field === 'k' || field === 'network') console.log(String(info[field]))
  else if (field === 'why') console.log(info.why.join('; '))
  else if (field === 'consensus') console.log(String(consensusPercent(info.n, info.k)))
  else throw new Error(`unknown field ${field}: expected n, k, network, consensus or why`)
}

if (require.main === module) {
  try {
    main()
  } catch (e) {
    console.error('ERROR', (e as Error).message)
    process.exit(1)
  }
}
