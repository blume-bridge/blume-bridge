import fs from 'node:fs'
import path from 'node:path'
import { keyProblems } from '../src/upgrade'

/**
 * Puts genesis/<GENESIS>.json into the bundle as dist/genesis.json (`npm run build`), adding the loader's upgrader keys.
 *
 *   UPGRADE_KEYS=ed…,ed…   the HotPocket user keys that may change the cluster's code (docs/BRIDGE_UPGRADES.md); wins over
 *                          an `upgrade` section the genesis file already has
 *
 * A bundle with no upgrader key can never be changed after its first upload, which for a mainnet genesis is almost surely a
 * mistake, so that build is refused unless IMMUTABLE=1 says it is meant.
 */
const name = process.env.GENESIS ?? 'dev'
const from = path.join(__dirname, '..', 'genesis', `${name}.json`)
const to = path.join(__dirname, '..', 'dist', 'genesis.json')
const genesis = JSON.parse(fs.readFileSync(from, 'utf8')) as { config?: { xrpl?: { network?: string } }; upgrade?: { upgraders?: string[] } }

const fromEnv = (process.env.UPGRADE_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)
if (fromEnv.length) genesis.upgrade = { upgraders: fromEnv }
const keys = genesis.upgrade?.upgraders ?? []
const problems = keyProblems(keys)
if (problems.length) throw new Error(`UPGRADE_KEYS: ${problems.join('; ')}`)
if (!keys.length && genesis.config?.xrpl?.network === 'mainnet' && process.env.IMMUTABLE !== '1') {
  throw new Error('this is a mainnet genesis with no upgrader key, so the cluster could never be changed. Set UPGRADE_KEYS=ed… (the public key of `admin.ts keygen --key keys/upgrade.json`), or IMMUTABLE=1 if that is meant.')
}

if (fromEnv.length) fs.writeFileSync(to, `${JSON.stringify(genesis, null, 2)}\n`)
else fs.copyFileSync(from, to)
console.log(`genesis ${name}: ${keys.length ? `${keys.length} upgrader key(s)` : 'no upgrader key: the code cannot be changed after the first upload'}`)
