/**
 * Read-only Evernode host discovery and the placement rule for the mainnet cluster. No wallet, no secrets, nothing is rented.
 *
 *   npx tsx scripts/evernode-hosts.ts list [--max-lease 0.01] [--min-rep 245] [--country NL,FR] [--version 1.0.0] [--limit 30] [--offers]
 *   npx tsx scripts/evernode-hosts.ts check hp/hosts.txt --n 3 --k 2 [--moments 720]
 *
 * `list` reads the registry on Xahau mainnet (about half a minute), keeps the active hosts with a free slot that match the filters,
 * best reputation first, and names each host's operator. `check` reads the hosts file scripts/evernode-cluster.sh will rent from
 * (one host address per line) and refuses a placement a host operator could abuse:
 *
 *   - an instance's operator can read its signing key (Decision 3), so no single operator may hold k or more of the n instances;
 *   - every instance needs a host of its own (one per host), active, with a free slot;
 *   - a host with a low reputation score has not been seen answering its peers;
 *   - a host with no lease offer cannot be leased from, whatever the registry's slot count says (the registry showed two free
 *     slots on a host that had one offer, and then none: 2026-10-18).
 *
 * "Operator" is guessed from the host's domain: the registrable part of it (node3.evernode-nl.info and node2.evernode-nl.info are one
 * operator). Two unrelated people can share a domain and one person can use several, so read the output, do not trust it blindly.
 * Exit 1 when `check` finds a problem.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

interface Host {
  address: string
  domain: string
  operator: string
  country: string
  lease: number
  reputation: number
  free: number
  slots: number
  version: string
  active: boolean
  /** Lease offers the host has open right now, counted on the ledger. null: not asked, or the host could not be reached. */
  offers: number | null
}

const has = (name: string): boolean => process.argv.includes(`--${name}`)
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** The part of a host's domain that names whoever runs it: the last two labels, three when the second-level is a country-style suffix. */
export function operatorOf(domain: string): string {
  const labels = domain.toLowerCase().split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.') || '(no domain)'
  const second = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'])
  return labels.slice(labels.length >= 3 && second.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? -3 : -2).join('.')
}

/** Why a placement is unsafe, or nothing. Pure, so the rule is tested without a network. */
export function placementProblems(hosts: (Pick<Host, 'address' | 'operator' | 'free' | 'active' | 'reputation'> & { offers?: number | null })[], n: number, k: number, minReputation = 200): string[] {
  const out: string[] = []
  if (hosts.length < n) out.push(`${hosts.length} host(s) for ${n} instances: every instance needs a host of its own, or one host holds several keys`)
  if (new Set(hosts.map((h) => h.address)).size !== hosts.length) out.push('a host address is listed twice')
  const perOperator = new Map<string, number>()
  for (const h of hosts.slice(0, n)) perOperator.set(h.operator, (perOperator.get(h.operator) ?? 0) + 1)
  for (const [operator, count] of perOperator) if (count >= k) out.push(`${operator} would run ${count} of the ${n} instances, and ${k} of them can sign for the bridge`)
  for (const h of hosts) {
    if (!h.active) out.push(`${h.address} is not active`)
    if (h.free < 1) out.push(`${h.address} has no free slot`)
    if (h.offers === 0) out.push(`${h.address} has no lease offer open, so nothing can be leased from it now`)
    if (h.reputation < minReputation) out.push(`${h.address} has reputation ${h.reputation}, under ${minReputation}`)
  }
  return out
}

export function library(): any {
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim()
  return require(path.join(root, 'evdevkit', 'node_modules', 'evernode-js-client'))
}

/** How many lease offers a host has open, from the host's own account on the ledger. */
export async function offersOf(ev: any, address: string): Promise<number | null> {
  const host = new ev.HostClient(address)
  try {
    await host.connect()
    const offers = await host.getLeaseOffers()
    return Array.isArray(offers) ? offers.length : null
  } catch {
    return null
  } finally {
    try {
      await host.disconnect()
    } catch {
      /* already closed */
    }
  }
}

async function registry(withDomains: (hosts: any[]) => any[] | Promise<any[]>, withOffers = false): Promise<{ hosts: Host[]; momentSeconds: number }> {
  const ev = library()
  await ev.Defaults.useNetwork('mainnet')
  const reg = await ev.HookClientFactory.create(ev.HookTypes.registry)
  await reg.connect()
  try {
    const raw: any[] = await reg.getAllHostsFromLedger(false)
    const picked = await withDomains(raw.filter((h) => h.active))
    const hosts: Host[] = []
    for (const h of picked) {
      const domain = h.domain ?? (await new ev.XrplAccount(h.address, null, { xrplApi: reg.xrplApi }).getDomain().catch(() => '')) ?? ''
      hosts.push({
        address: h.address,
        domain,
        operator: operatorOf(domain),
        country: h.countryCode ?? '--',
        lease: Number(h.leaseAmount),
        reputation: h.hostReputation ?? 0,
        free: (h.maxInstances ?? 0) - (h.activeInstances ?? 0),
        slots: h.maxInstances ?? 0,
        version: h.version ?? '?',
        active: !!h.active,
        offers: withOffers ? await offersOf(ev, h.address) : null,
      })
    }
    return { hosts, momentSeconds: reg.config.momentSize }
  } finally {
    await reg.disconnect()
  }
}

async function list(): Promise<void> {
  const maxLease = Number(flag('max-lease') ?? 0.01)
  const minRep = Number(flag('min-rep') ?? 245)
  const countries = (flag('country') ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
  const version = flag('version')
  const limit = Number(flag('limit') ?? 30)
  const { hosts } = await registry((all) => {
    const keep = all.filter((h) => (h.maxInstances ?? 0) - (h.activeInstances ?? 0) > 0 && Number(h.leaseAmount) <= maxLease && (h.hostReputation ?? 0) >= minRep && (!countries.length || countries.includes(String(h.countryCode).toUpperCase())) && (!version || h.version === version))
    keep.sort((a, b) => (b.hostReputation ?? 0) - (a.hostReputation ?? 0) || Number(a.leaseAmount) - Number(b.leaseAmount))
    return keep.slice(0, limit)
  }, has('offers'))
  const seen = new Set<string>()
  console.log(`address                            operator                         cc  lease(EVR/h)  rep  free${has('offers') ? '  offers' : ''}  version`)
  for (const h of hosts) {
    console.log(`${h.address}  ${h.operator.padEnd(31)}  ${h.country}  ${String(h.lease).padEnd(12)}  ${String(h.reputation).padEnd(3)}  ${h.free}/${h.slots}${has('offers') ? `  ${String(h.offers ?? '?').padEnd(6)}` : ''}   ${h.version}${seen.has(h.operator) ? '   (same operator as a row above)' : ''}`)
    seen.add(h.operator)
  }
  console.log(`\n${hosts.length} shown. One instance per operator: pick hosts whose operators differ.`)
}

async function check(): Promise<void> {
  const file = process.argv[3]
  if (!file || file.startsWith('--')) throw new Error('usage: evernode-hosts.ts check <hosts file> --n 3 --k 2 [--moments 720]')
  const n = Number(flag('n'))
  const k = Number(flag('k'))
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 1 || k > n || 2 * k <= n) throw new Error('--n and --k are required, with k a majority of n')
  const addresses = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(l))
  const { hosts: all, momentSeconds } = await registry((hosts) => hosts.filter((h) => addresses.includes(h.address)), true)
  const byAddress = new Map(all.map((h) => [h.address, h]))
  const missing = addresses.filter((a) => !byAddress.has(a))
  const hosts = addresses.map((a) => byAddress.get(a)).filter((h): h is Host => !!h)
  for (const h of hosts) console.log(`${h.address}  ${h.domain.padEnd(36)} ${h.country}  lease ${h.lease} EVR/moment  rep ${h.reputation}  free ${h.free}/${h.slots}  offers ${h.offers ?? '?'}  ${h.version}  operator ${h.operator}`)
  const problems = [...missing.map((a) => `${a} is not an active host in the registry`), ...placementProblems(hosts, n, k)]
  const moments = Number(flag('moments') ?? 720)
  const evr = hosts.slice(0, n).reduce((sum, h) => sum + h.lease * moments, 0)
  console.log(`\n${n} instances for ${moments} moments (${((moments * momentSeconds) / 86400).toFixed(0)} days): about ${evr.toFixed(4)} EVR in leases`)
  if (problems.length) {
    console.log('\nPROBLEMS:')
    for (const p of problems) console.log(`  - ${p}`)
    process.exit(1)
  }
  console.log(`placement ok: no operator holds ${k} or more of the ${n} instances`)
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (cmd === 'list') return list()
  if (cmd === 'check') return check()
  console.log('usage: npx tsx scripts/evernode-hosts.ts list [filters] | check <hosts file> --n 3 --k 2')
  process.exit(1)
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('ERROR', e?.message ?? e)
      process.exit(1)
    })
}
