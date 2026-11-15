import fs from 'node:fs'
import path from 'node:path'
import HotPocket from 'hotpocket-js-client'

/**
 * Operator commands for a running bridge cluster (src/admin.ts), sent as a HotPocket user whose key the genesis lists
 * under `config.admins`. The key is a file (keys/admin.json, mode 600, gitignored): `keygen` makes it and prints only
 * the PUBLIC key, which goes into the genesis (ADMIN_KEYS) before the cluster boots. Treat the file like a node key.
 *
 *   npx tsx scripts/admin.ts keygen
 *   npx tsx scripts/admin.ts pubkey
 *   npx tsx scripts/admin.ts cap SYM UNITS|uncapped        --node bridge-main.blumefi.com:8443
 *   npx tsx scripts/admin.ts listings open|wait            --node ...    # a new listing opens by itself, or waits for `cap`
 *   npx tsx scripts/admin.ts pause [SYM]                   --node ...
 *   npx tsx scripts/admin.ts resume [SYM]                  --node ...
 *   npx tsx scripts/admin.ts refund TX                     --node ...    # a lock waiting for its fee, or an unmatched payment
 *   npx tsx scripts/admin.ts meta SYM [--name N] [--image ID|ipfs://CID|""]  --node ...
 *   npx tsx scripts/admin.ts evm MINTER FROM               --node ...    # once, after the minter is deployed: FROM is the block it was deployed in
 *   npx tsx scripts/admin.ts show tokens|operators|unmatched|transfers|status --node ...   # a read; no key needed
 *
 * --node (or BRIDGE_NODE) is host:port of a front door or a node's user port. --key picks another key file.
 * --dry-run prints the message and sends nothing.
 */
HotPocket.setLogLevel(2)

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const positional = (() => {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (args[i] !== '--dry-run') i++
    } else out.push(args[i])
  }
  return out
})()
const KEY_FILE = path.resolve(flag('key') ?? path.join(__dirname, '..', 'keys', 'admin.json'))
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex')

async function loadKeys() {
  const file = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) as { privateKeyHex: string }
  return HotPocket.generateKeys(file.privateKeyHex)
}

function message(cmd: string, rest: string[]): Record<string, string> {
  const id = `admin-${Date.now()}`
  switch (cmd) {
    case 'cap':
      if (rest.length !== 2) throw new Error('usage: cap SYM UNITS|uncapped')
      return { type: 'admin', id, cmd, sym: rest[0], units: rest[1] }
    case 'listings':
      if (rest.length !== 1 || !['open', 'wait'].includes(rest[0])) throw new Error('usage: listings open|wait')
      return { type: 'admin', id, cmd, mode: rest[0] }
    case 'pause':
    case 'resume':
      return { type: 'admin', id, cmd, ...(rest[0] ? { sym: rest[0] } : {}) }
    case 'refund':
      if (rest.length !== 1) throw new Error('usage: refund TX')
      return { type: 'admin', id, cmd, tx: rest[0] }
    case 'evm':
      if (rest.length !== 2) throw new Error('usage: evm MINTER FROM  (FROM: the block the minter was deployed in)')
      if (!/^0x[0-9a-fA-F]{40}$/.test(rest[0])) throw new Error('MINTER must be the minter contract address (0x and 40 hex digits)')
      if (!/^[1-9]\d*$/.test(rest[1])) throw new Error('FROM must be a block number')
      return { type: 'admin', id, cmd, minter: rest[0], from: rest[1] }
    case 'meta': {
      if (rest.length < 1) throw new Error('usage: meta SYM [--name N] [--image ID]')
      const name = flag('name')
      const image = flag('image')
      if (name === undefined && image === undefined) throw new Error('meta needs --name and/or --image')
      return { type: 'admin', id, cmd, sym: rest[0], ...(name !== undefined ? { name } : {}), ...(image !== undefined ? { image } : {}) }
    }
    default:
      throw new Error(`unknown command ${JSON.stringify(cmd)}`)
  }
}

async function main() {
  const [cmd, ...rest] = positional
  if (cmd === 'keygen') {
    if (fs.existsSync(KEY_FILE)) throw new Error(`${KEY_FILE} exists: refusing to overwrite an operator key`)
    const keys = await HotPocket.generateKeys()
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true })
    fs.writeFileSync(KEY_FILE, JSON.stringify({ privateKeyHex: hex(keys.privateKey), publicKeyHex: hex(keys.publicKey) }), { mode: 0o600 })
    console.log(`wrote ${KEY_FILE} (mode 600). Its public key goes in the genesis: ADMIN_KEYS for an operator key, UPGRADE_KEYS (at build time) for an upgrade key:\n${hex(keys.publicKey)}`)
    return
  }
  if (cmd === 'pubkey') {
    console.log(hex((await loadKeys()).publicKey))
    return
  }
  if (!cmd) throw new Error('usage: admin <keygen|pubkey|cap|listings|pause|resume|refund|meta|show> ...')

  const node = flag('node') ?? process.env.BRIDGE_NODE
  const isShow = cmd === 'show'
  const msg = isShow ? { type: rest[0], id: `show-${Date.now()}` } : message(cmd, rest)
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify(msg))
    return
  }
  if (!node) throw new Error('--node host:port (or BRIDGE_NODE) is required')
  const keys = isShow ? await HotPocket.generateKeys() : await loadKeys()
  const client = await HotPocket.createClient([`wss://${node}`], keys)
  if (!(await client.connect())) throw new Error(`cannot connect to ${node}`)
  try {
    if (isShow) {
      console.log(JSON.stringify(await client.submitContractReadRequest(JSON.stringify(msg)), null, 2))
      return
    }
    const done = new Promise<{ outputs: unknown[] }>((resolve) => client.on(HotPocket.events.contractOutput, (r: { outputs: unknown[] }) => resolve(r)))
    const sub = await client.submitContractInput(JSON.stringify(msg))
    const status = await sub.submissionStatus
    if (status.status !== 'accepted') throw new Error(`rejected: ${status.reason}`)
    const out = await Promise.race([done, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no answer in 30 s: the command may still have been applied; check with `show tokens`')), 30000))])
    for (const o of out.outputs) console.log(typeof o === 'string' ? o : JSON.stringify(o))
  } finally {
    await client.close()
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR', e?.message ?? e)
    process.exit(1)
  })
