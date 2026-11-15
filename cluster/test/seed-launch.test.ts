import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { chosen, supplyOf, type Pick } from '../scripts/seed-build'
import { normalizeCurrency, parseImage } from '../src/listing'

/** The day-one token list: the leading meme tokens first, then XAH, EVR and the earlier picks, the rest ready and held back. */
const picks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed', 'picks.json'), 'utf8')) as Pick[]
const names = (list: Pick[]) => list.map((p) => p.name)

describe('which seed tokens are built', () => {
  it('is the picks marked launch by default, in the order the picker shows them, and under thirty', () => {
    const launch = chosen(picks, {})
    expect(names(launch)).toEqual([
      // The leading meme tokens, ranked on 2026-10-18 by holders, pool depth and 7-day trading (First Ledger, xMagnetic, XRPL Meta).
      'Fuzzybear', 'Phoenix', 'ARMY', 'DROP', 'BEAR', 'Bear Champ', 'ALL THE MONEY', '666', '589', 'Salute',
      'Bert the Bird', 'Farm', 'Scrappy', 'Sigma', 'JoeLee', 'Common Bird', 'Schmeckles', 'XRP on XRP', 'CULT', 'PONGO',
      // Then the picks asked for by name, the issuers that can still sign (XAH, EVR) and the older non-meme coins.
      'lolnuked', 'Xahau (GateHub)', 'Evernode (GateHub)', 'Sologenic', 'XPMarket', 'Elysian', 'CasinoCoin', 'Magnetic X', 'LHT',
    ])
    // Every listed token is a lock-account trust line, an ERC-20 and something to watch.
    expect(launch.length).toBeLessThanOrEqual(30)
  })

  it('puts every meme token ahead of every coin that is not one (the site\'s picker opens in this order: featured.ts)', () => {
    // 2026-10-18: "it's the leading meme tokens they are going to want to trade". SOLO, XPM, ELS, CSC, MAG, LHT stay on the list
    // but come after them; XAH and EVR come right after the memes.
    const notMemes = ['Xahau (GateHub)', 'Evernode (GateHub)', 'Sologenic', 'XPMarket', 'Elysian', 'CasinoCoin', 'Magnetic X', 'LHT']
    const launch = names(chosen(picks, {}))
    const firstOther = Math.min(...notMemes.map((n) => launch.indexOf(n)))
    expect(firstOther).toBeGreaterThanOrEqual(20)
    for (const n of launch.slice(0, firstOther)) expect(notMemes, `${n} leads the list`).not.toContain(n)
  })

  it('builds every pick with ALL=1 and the named tickers with ONLY, whatever their mark', () => {
    expect(chosen(picks, { ALL: '1' })).toHaveLength(picks.length)
    expect(names(chosen(picks, { ONLY: 'solo, DROP' }))).toEqual(['DROP', 'Sologenic']) // the file's order, not the order asked for
    expect(names(chosen(picks, { ONLY: 'USD', ALL: '1' }))).toEqual(['GateHub USD'])
  })

  it('refuses a ticker that is not in the file, and a file where nothing is marked', () => {
    expect(() => chosen(picks, { ONLY: 'SOLO,NOPE' })).toThrow(/NOPE/)
    expect(() => chosen(picks.map((p) => ({ ...p, launch: undefined })), {})).toThrow(/no pick is marked/)
  })

  it('starts with meme tokens plus XAH and EVR, and none of the GateHub fiat or crypto IOUs', () => {
    // 2026-10-17: primarily meme tokens, no GateHub USD/EUR/BTC/ETH, XAH and EVR in. The issuers of those two can still sign, so
    // only the issuer or a genesis can ever list them: that is why they are in the first build and not left for later.
    const launch = names(chosen(picks, {}))
    for (const left of ['GateHub USD', 'GateHub EUR', 'GateHub BTC', 'GateHub ETH', 'RippleFox CNY']) expect(launch, left).not.toContain(left)
    expect(launch).toContain('Xahau (GateHub)')
    expect(launch).toContain('Evernode (GateHub)')
  })

  it('has only picks the cluster accepts, each with its own ticker, an issuer address and a link the minter takes as a logo', () => {
    const tickers = new Map<string, string>()
    for (const p of picks) {
      const cur = normalizeCurrency(p.currency)
      expect('error' in cur ? cur.error : '', `${p.name}: currency ${p.currency}`).toBe('')
      if ('error' in cur) continue
      const ticker = cur.ticker.toUpperCase()
      expect(tickers.get(ticker), `${p.name} shares the ticker ${ticker}`).toBeUndefined()
      tickers.set(ticker, p.name)
      expect(p.issuer, `${p.name}: issuer`).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/)
      if (p.image) expect(parseImage(p.image), `${p.name}: image ${p.image}`).toBeTruthy()
    }
  })

  it('carries a logo for every launch token', () => {
    // EVR and CULT publish none of their own: since the launch they carry Evernode's mark and xMagnetic's icon (set with admin meta, 2026-10-18).
    for (const p of chosen(picks, {})) expect(p.image, `${p.name} has a logo to carry`).toBeTruthy()
  })
})

describe('the trust line limit of a seed token is its own supply', () => {
  // gateway_balances reports what an issuer has outstanding, by currency code as the ledger writes it.
  const obligations = { SLT: '61240000000', '504F4E474F000000000000000000000000000000': '99980000000000', XAH: '2.371e+7', DUST: '0', ODD: 'lots', FRAC: '1234.5678' }

  it('is the amount the issuer has outstanding, as a plain decimal', () => {
    expect(supplyOf(obligations, 'SLT')).toBe('61240000000')
    expect(supplyOf(obligations, '504F4E474F000000000000000000000000000000')).toBe('99980000000000')
    expect(supplyOf(obligations, 'XAH')).toBe('23710000')
    expect(supplyOf(obligations, 'FRAC')).toBe('1234.5678')
  })
  it('is null where there is nothing to size by: no entry, nothing outstanding, or not a number', () => {
    expect(supplyOf(obligations, 'NOPE')).toBeNull()
    expect(supplyOf(obligations, 'DUST')).toBeNull()
    expect(supplyOf(obligations, 'ODD')).toBeNull()
    expect(supplyOf(undefined, 'SLT')).toBeNull()
  })
})
