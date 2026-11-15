/**
 * Builds the mainnet seed list, seed/mainnet.json, from the curated picks in
 * seed/picks.json: the tokens the bridge lists on day one. For each pick it
 * reads the issuer's account as mainnet has it now and drops anything the
 * cluster itself would refuse (clawback, RequireAuth, a global freeze,
 * DefaultRipple off), records the issuer's transfer fee and domain, prices the
 * token in XRP from its XRP AMM pool (the order book when it has no pool), and
 * sets its cap to CAP_XRP worth of tokens when CAP_XRP is given (none by default), and sets the lock account's trust line limit to the
 * token's own total supply (the issuer's outstanding amount, gateway_balances), never a round number. Read-only, no keys. Run it the day
 * of the boot, then scripts/mainnet-genesis.ts.
 *
 *   npx tsx scripts/seed-build.ts                 # the picks marked launch (the day-one list), with no cap
 *   CAP_XRP=1000 npx tsx scripts/seed-build.ts    # each capped at 1,000 XRP worth, priced from its pool
 *   ALL=1 npx tsx scripts/seed-build.ts           # every pick
 *   ONLY=SOLO,XPM npx tsx scripts/seed-build.ts   # these tickers
 *   CAP_XRP=500 PICKS=seed/picks.json OUT=seed/mainnet.json npx tsx scripts/seed-build.ts
 *
 * A pick is { currency, issuer, name, image?, imageSource? }: the currency
 * exactly as the ledger reports it, the name people know it by, and the
 * token's own logo exactly as it is published: an `ipfs://` link when the
 * issuer published one (First Ledger tokens do), otherwise the https link its
 * issuer file (xrp-ledger.toml) or its token list gives. Nothing is uploaded
 * or copied; `imageSource` only says where the link was found. A coin that
 * publishes none gets none, and an operator adds one later (admin.ts meta).
 */
import fs from 'node:fs'
import path from 'node:path'
import { issuerFromAccountInfo } from '../src/feed/xrpl'
import * as dec from '../src/dec'
import { cleanName, keyFor, normalizeCurrency, parseImage, RATE_ONE } from '../src/listing'
import { canFreeze } from '../src/machine'
import type { TokenRec } from '../src/types'
import { jsonRpc } from './network'

export interface Pick {
  currency: string
  issuer: string
  name: string
  image?: string
  /** Where the logo was published, for the record. */
  imageSource?: string
  /** On the day-one list. The picks without it are built only with ALL=1 or ONLY=. */
  launch?: boolean
}

const rpc = <T = any>(method: string, params: Record<string, unknown>) => jsonRpc<T>('mainnet', method, params)
const PKG = path.join(__dirname, '..')

/**
 * What an issuer has outstanding in one currency, from the `obligations` gateway_balances reports, written as a plain decimal; null when
 * it has none. That is the token's total supply: the most there is, so the most the lock account's trust line could ever need to take.
 */
export function supplyOf(obligations: Record<string, string> | undefined, currency: string): string | null {
  const raw = obligations?.[currency] ?? obligations?.[currency.toUpperCase()]
  if (raw === undefined) return null
  try {
    const n = dec.parse(String(raw))
    return n > 0n ? dec.format(n) : null
  } catch {
    return null
  }
}

/** XRP per token from the token's XRP AMM pool, or null when it has none. */
async function ammPrice(currency: string, issuer: string): Promise<number | null> {
  try {
    const r = await rpc<{ amm: { amount: string | { value: string }; amount2: string | { value: string } } }>('amm_info', { asset: { currency: 'XRP' }, asset2: { currency, issuer }, ledger_index: 'validated' })
    const xrpSide = typeof r.amm.amount === 'string' ? r.amm.amount : r.amm.amount2
    const tokenSide = typeof r.amm.amount === 'string' ? r.amm.amount2 : r.amm.amount
    const xrp = Number(xrpSide) / 1e6
    const tokens = Number((tokenSide as { value: string }).value)
    return xrp > 0 && tokens > 0 ? xrp / tokens : null
  } catch {
    return null
  }
}

/** XRP per token from the best offer selling the token for XRP, or null when the book is empty. The ask, not a mid: it prices the token higher, so the cap in tokens comes out smaller. */
async function bookPrice(currency: string, issuer: string): Promise<number | null> {
  try {
    const r = await rpc<{ offers: { TakerGets: { value: string } | string; TakerPays: string | { value: string }; taker_gets_funded?: { value: string }; taker_pays_funded?: string }[] }>('book_offers', { taker_gets: { currency, issuer }, taker_pays: { currency: 'XRP' }, limit: 5, ledger_index: 'validated' })
    for (const o of r.offers ?? []) {
      const gets = Number((o.taker_gets_funded ?? (o.TakerGets as { value: string })).value)
      const pays = Number(o.taker_pays_funded ?? (o.TakerPays as string)) / 1e6
      if (gets > 0 && pays > 0) return pays / gets
    }
  } catch {
    /* no book */
  }
  return null
}

/** The ticker a pick will be listed under, or '' for a currency the cluster would refuse. */
function tickerOfPick(p: Pick): string {
  const c = normalizeCurrency(p.currency)
  return 'error' in c ? '' : c.ticker.toUpperCase()
}

/**
 * Which picks to build. The day-one list is the picks marked `launch: true` (a few tokens to start with: every listed token is a
 * lock-account trust line, an ERC-20 and a cap to watch). ONLY=SOLO,XPM names tickers instead; ALL=1 builds every pick. A token whose
 * issuer is locked for good can be listed later by anyone for the flat fee; one whose issuer can still sign can only be listed by its
 * issuer or in a genesis, so it belongs in this build or nowhere.
 */
export function chosen(picks: Pick[], env: { ONLY?: string; ALL?: string }): Pick[] {
  const only = (env.ONLY ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
  if (only.length) {
    const known = new Set(picks.map(tickerOfPick))
    const unknown = only.filter((t) => !known.has(t))
    if (unknown.length) throw new Error(`ONLY names ${unknown.join(', ')}, which are not in the picks file (${[...known].filter(Boolean).join(', ')})`)
    return picks.filter((p) => only.includes(tickerOfPick(p)))
  }
  if (env.ALL === '1') return picks
  const launch = picks.filter((p) => p.launch === true)
  if (!launch.length) throw new Error('no pick is marked "launch": true. Mark the day-one tokens in the picks file, or run with ALL=1 or ONLY=SOLO,XPM')
  return launch
}

/** A plain decimal string with at most 6 significant digits: the cap is a round number, not a precise one. */
function roundCap(units: number): string {
  return units.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 6 })
}

async function main() {
  const picksFile = path.resolve(PKG, process.env.PICKS ?? 'seed/picks.json')
  const outFile = path.resolve(PKG, process.env.OUT ?? 'seed/mainnet.json')
  // No cap by default (2026-10-17: "I don't think we need those"): a seed token takes whatever is bridged. CAP_XRP=1000 caps each at that many
  // XRP worth, priced from its pool, and an operator can set or lift any token's cap at any time (admin.ts cap SYM UNITS|uncapped).
  const capEnv = (process.env.CAP_XRP ?? '').trim().toLowerCase()
  const uncapped = capEnv === '' || capEnv === 'none' || capEnv === 'uncapped'
  const capXrp = uncapped ? 0 : Number(capEnv)
  if (!uncapped && !(capXrp > 0)) throw new Error('CAP_XRP must be a positive number of XRP, or "none" for no cap')
  const candidates = JSON.parse(fs.readFileSync(picksFile, 'utf8')) as Pick[]
  const picks = chosen(candidates, process.env)
  const held = candidates.filter((c) => !picks.includes(c))
  if (held.length) console.log(`  held back (not marked launch; ALL=1 builds every pick, ONLY=SOLO,XPM names some): ${held.map((h) => h.name).join(', ')}\n`)
  const tokens: Record<string, TokenRec> = {}
  const prices: Record<string, { xrp: number; from: 'amm' | 'book' }> = {}
  const dropped: { pick: string; why: string }[] = []
  const obligationsOf = new Map<string, Record<string, string>>()
  for (const pick of picks) {
    const label = `${pick.name} (${pick.currency}.${pick.issuer})`
    const cur = normalizeCurrency(pick.currency)
    if ('error' in cur) {
      dropped.push({ pick: label, why: cur.error })
      continue
    }
    const image = pick.image ? parseImage(pick.image) : undefined
    if (image === null) {
      dropped.push({ pick: label, why: `image ${pick.image} is neither an https:// link nor an ipfs:// link` })
      continue
    }
    const info = issuerFromAccountInfo(await rpc('account_info', { account: pick.issuer, ledger_index: 'validated', signer_lists: true }))
    const refusal = info.clawback ? 'clawback' : info.requireAuth ? 'requires approval for trust lines' : info.globalFreeze ? 'global freeze' : !info.defaultRipple ? 'DefaultRipple off' : null
    if (refusal) {
      dropped.push({ pick: label, why: refusal })
      continue
    }
    // The lock account's trust line takes what the token's supply is, exactly: read from the ledger, not a number picked here.
    let obligations = obligationsOf.get(pick.issuer)
    if (!obligations) {
      obligations = ((await rpc<{ obligations?: Record<string, string> }>('gateway_balances', { account: pick.issuer, ledger_index: 'validated' })).obligations ?? {}) as Record<string, string>
      obligationsOf.set(pick.issuer, obligations)
    }
    const supply = supplyOf(obligations, cur.currency)
    if (supply === null) {
      dropped.push({ pick: label, why: 'the issuer has nothing outstanding in this currency, so there is no supply to size the trust line by' })
      continue
    }
    const amm = await ammPrice(cur.currency, pick.issuer)
    const price = amm ?? (await bookPrice(cur.currency, pick.issuer))
    if (price === null && !uncapped) {
      dropped.push({ pick: label, why: 'no XRP pool and an empty order book: no price to cap it by' })
      continue
    }
    const sym = keyFor(tokens, cur.ticker, pick.issuer)
    const rate = info.transferRate ?? RATE_ONE
    tokens[sym] = {
      sym,
      ticker: cur.ticker,
      name: cleanName(pick.name, cur.ticker),
      ...(image ? { image } : {}),
      issuer: pick.issuer,
      currency: cur.currency,
      status: 'listed',
      lane: 'genesis',
      trustLimit: supply,
      ...(uncapped ? {} : { capUnits: roundCap(capXrp / price!) }),
      lockedUnits: '0',
      dustUnits: '0',
      noFreezeUnset: canFreeze(info),
      ...(info.blackholed ? { issuerLocked: true } : {}),
      ...(rate > RATE_ONE ? { transferRate: rate } : {}),
      ...(info.domain ? { domain: info.domain } : {}),
    }
    if (price !== null) prices[sym] = { xrp: price, from: amm !== null ? 'amm' : 'book' }
    const fee = rate > RATE_ONE ? `, issuer fee ${((rate - RATE_ONE) / 1e7).toFixed(2)}%` : ''
    const priced = price === null ? 'no price'.padStart(12) + '          ' : `${price.toPrecision(4).padStart(12)} XRP each (${prices[sym].from})`
    console.log(`  ${sym.padEnd(8)} ${tokens[sym].name.padEnd(18)} ${priced} → ${uncapped ? 'no cap' : `cap ${tokens[sym].capUnits}`}${fee}${info.blackholed ? ', issuer locked for good' : ', issuer can still sign'}${image ? '' : ', NO LOGO'}, trust line ${supply}`)
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({ builtAt: new Date().toISOString(), capXrp: uncapped ? null : capXrp, prices, dropped, tokens }, null, 2) + '\n')
  console.log(`\n  ${Object.keys(tokens).length} tokens written to ${path.relative(process.cwd(), outFile)}, ${uncapped ? 'with no cap: whatever is bridged is taken (an operator can set one any time)' : `each capped at ${capXrp} XRP worth`}`)
  for (const d of dropped) console.log(`  dropped ${d.pick}: ${d.why}`)
  const noLogo = Object.values(tokens).filter((t) => !t.image)
  if (noLogo.length) console.log(`  ${noLogo.length} without a logo: ${noLogo.map((t) => t.ticker).join(', ')}. They publish none; an operator can add one after the boot (npx tsx scripts/admin.ts meta SYM --image <link>), or put its https:// or ipfs:// link in its pick now.`)
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR', e?.message ?? e)
    process.exit(1)
  })
}
