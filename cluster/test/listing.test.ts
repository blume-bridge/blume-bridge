import { describe, expect, it } from 'vitest'
import { applyAdmin } from '../src/admin'
import { applyEvmView, applyView, canFreeze, createTestBurn, queueEvmWork, tick, toWei } from '../src/machine'
import { tokenIdOf } from '../src/evm'
import { issuerFromAccountInfo, refreshTurn } from '../src/feed/xrpl'
import { cleanName, erc20Name, erc20Symbol, keyFor, normalizeCurrency, parseImage, parseProposal, proposalIssuer } from '../src/listing'
import type { IssuerFlags, State, XrplOutgoingEvent, XrplPaymentEvent, XrplView } from '../src/types'
import genesis from '../genesis/dev.json'
import { baseState, evmState, feeOf, intent, lockOf } from './helpers'

const ALICE = 'rJfqVsXN3i6AD9ErSdNo98cyoKw6Euxj8K'
const BOB = 'rpXzhnkZN2JArdmWAk3tmrtJwsErv963Na'
/** An issuer for the new tokens in these tests; it signs for itself unless a test says it is locked for good. */
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const NOW = 1788912000000
const LOCK = genesis.config.xrpl.lockAccount
const FUND = genesis.config.xrpl.fundingAccount
const MOO = '4D4F4F0000000000000000000000000000000000'
const LOGO = 'https://static.xrplmeta.org/icons/MOO.png'

const base = baseState
const evmBase = evmState
const accounts = (lockSeq = 10, fundSeq = 20) => ({ [LOCK]: { sequence: lockSeq, balanceDrops: '100000000' }, [FUND]: { sequence: fundSeq, balanceDrops: '125000000' } })
const xrp = (value: string) => ({ currency: 'XRP', value })
let seq = 0
function pay(to: string, amount: XrplPaymentEvent['amount'], memo: string | null, extra: Partial<XrplPaymentEvent> = {}): XrplPaymentEvent {
  seq++
  return { kind: 'payment', tx: `LTX${String(seq).padStart(4, '0')}`, ledger: 102, from: ALICE, to, amount, memo, ...extra }
}
const view = (s: State, events: (XrplPaymentEvent | XrplOutgoingEvent)[], extra: Partial<XrplView> = {}): XrplView => ({ src: 'xrpl', from: s.cursor.xrpl.ledger, to: s.cursor.xrpl.ledger + 5, events, accounts: accounts(), ...extra })
const evmView = (s: State, events: any[], listings: Record<string, { token: string; dailyCapWei: string; metaNonce?: string }> = {}) => ({ src: 'evm' as const, from: s.cursor.evm!.block, to: s.cursor.evm!.block + 10, events, listings })

const signs: IssuerFlags = { noFreeze: true, globalFreeze: false, requireAuth: false, clawback: false, defaultRipple: true, disableMaster: false, blackholed: false, transferRate: 1_000_000_000 }
const lockedForGood: IssuerFlags = { ...signs, disableMaster: true, blackholed: true }
const memo = (o: Record<string, unknown>) => `propose:${JSON.stringify(o)}`
const returnsTo = (s: State, to: string) => Object.values(s.actions).filter((a) => a.reason.kind === 'return' && a.reason.to === to)

describe('currency codes', () => {
  it('reads a 3-character code as its own ticker and refuses XRP', () => {
    expect(normalizeCurrency('USD')).toEqual({ currency: 'USD', ticker: 'USD' })
    expect(normalizeCurrency('xrp')).toEqual({ error: 'xrp' })
  })
  it('decodes a 40-hex code, upper-casing the hex the ledger reports', () => {
    expect(normalizeCurrency('504554414c000000000000000000000000000000')).toEqual({ currency: '504554414C000000000000000000000000000000', ticker: 'PETAL' })
    expect(normalizeCurrency(MOO)).toEqual({ currency: MOO, ticker: 'MOO' })
  })
  it('turns the hex form of a standard code back into its 3 characters, so the token id matches the ledger', () => {
    expect(normalizeCurrency('0000000000000000000000005553440000000000')).toEqual({ currency: 'USD', ticker: 'USD' })
    expect(normalizeCurrency('0000000000000000000000005852500000000000')).toEqual({ error: 'xrp' })
    expect(normalizeCurrency('0000000000000000000000005553440000000001')).toEqual({ error: 'bad-currency' })
  })
  it('refuses demurrage codes, AMM pool shares and codes that are not printable text', () => {
    expect(normalizeCurrency('01' + '00'.repeat(19))).toEqual({ error: 'demurrage' })
    expect(normalizeCurrency('03B245BE580EC4F4386A751C084489EC4B514A2F')).toEqual({ error: 'lp-token' })
    expect(normalizeCurrency('41420043' + '00'.repeat(16))).toEqual({ error: 'bad-ticker' })
    expect(normalizeCurrency('FF' + '00'.repeat(19))).toEqual({ error: 'bad-ticker' })
    expect(normalizeCurrency('ABC1')).toEqual({ error: 'bad-currency' })
  })
  it('keeps a mixed-case ticker as the ledger spells it', () => {
    const hex = Buffer.from('Xoge').toString('hex').toUpperCase().padEnd(40, '0')
    expect(normalizeCurrency(hex)).toEqual({ currency: hex, ticker: 'Xoge' })
  })
})

describe('names, logos and ERC-20 metadata', () => {
  it('cleans a name and falls back to the ticker', () => {
    expect(cleanName('  Moo\n\tToken  ', 'MOO')).toBe('Moo Token')
    expect(cleanName('', 'MOO')).toBe('MOO')
    expect(cleanName('x'.repeat(60), 'MOO')).toHaveLength(40)
    // 4-byte characters: 40 of them would be 160 bytes, the minter takes 64
    expect(Buffer.byteLength(cleanName('🌸'.repeat(40), 'MOO'))).toBeLessThanOrEqual(64)
  })
  it('carries a logo as the coin publishes it: an https link as it is, IPFS kept as the original, nothing uploaded', () => {
    // a web link, exactly as published (the form most coins' lists and issuer files give)
    expect(parseImage(LOGO)).toBe(LOGO)
    expect(parseImage('https://www.gravatar.com/avatar/193eebea5db96b7e2f2897cedaca29b4?s=256')).toBe('https://www.gravatar.com/avatar/193eebea5db96b7e2f2897cedaca29b4?s=256')
    expect(parseImage('  https://cdn.xumm.pro/token-avatars/Xah_asset_rounded.png ')).toBe('https://cdn.xumm.pro/token-avatars/Xah_asset_rounded.png')
    // an Arweave copy, if one already exists, is just a web link
    expect(parseImage('https://arweave.net/aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-abcde')).toBe('https://arweave.net/aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-abcde')
    // FUZZY's logo as First Ledger published it: reused, not copied, and the gateway it was published on does not matter
    const cid = 'QmWGNu6FmQDQNHDnxGek3DPQj832G3qzs4kfDddMSttYMk'
    expect(parseImage(`ipfs://${cid}`)).toBe(`ipfs://${cid}`)
    expect(parseImage(`https://ipfs.firstledger.net/ipfs/${cid}`)).toBe(`ipfs://${cid}`)
    expect(parseImage(`https://gateway.pinata.cloud/ipfs/${cid}/logo.png`)).toBe(`ipfs://${cid}/logo.png`)
    expect(parseImage('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')
  })
  it('refuses what is not a safe logo link', () => {
    const cid = 'QmWGNu6FmQDQNHDnxGek3DPQj832G3qzs4kfDddMSttYMk'
    for (const bad of [
      'http://static.xrplmeta.org/icons/MOO.png', // not https
      'https://user:pass@static.xrplmeta.org/icons/MOO.png', // credentials in the link
      'https://127.0.0.1/x.png', // an address, not a domain name
      'https://10.0.0.5/x.png',
      'https://[::1]/x.png',
      'https://localhost/x.png',
      'https://intranet/x.png', // no dot
      'https://files.corp/x.png',
      'https://nas.local/x.png',
      'https://xn--e1afmkfd.xn--p1ai/\u00e9.png', // not ASCII
      'https://static.xrplmeta.org/icons/MOO .png', // whitespace
      'https://static.xrplmeta.org/' + 'a'.repeat(300), // longer than the contract takes (256)
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'ar://short',
      'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-abcde', // a bare Arweave id is no longer a form: nothing is uploaded
      'ipfs://not-a-cid',
      `ipfs://${cid}/../../etc`,
      '',
      undefined,
      null,
      5,
    ]) expect(parseImage(bad), String(bad).slice(0, 60)).toBeNull()
  })
  it('cuts the ERC-20 symbol to what a wallet will watch and the name to what the minter takes', () => {
    expect(erc20Symbol({ ticker: 'SeagullCoinXYZ', sym: 'SEAGULLCOINX' })).toBe('SeagullCoin')
    expect(erc20Symbol({ sym: 'PETAL' })).toBe('PETAL')
    expect(erc20Name({ name: 'Moo Token', sym: 'MOO' })).toBe('Moo Token')
  })
})

describe('proposal memos', () => {
  it('reads the JSON form and the first form', () => {
    expect(parseProposal(JSON.stringify({ c: MOO, i: ISSUER, n: 'Moo', img: LOGO }))).toEqual({ currency: MOO, issuer: ISSUER, name: 'Moo', image: LOGO })
    // a long link is kept whole so that parseImage refuses it, never cut into a different valid-looking one
    const long = 'https://static.xrplmeta.org/' + 'a'.repeat(400)
    expect(parseProposal(JSON.stringify({ c: MOO, i: ISSUER, img: long }))?.image).toBe(long)
    expect(parseImage(long)).toBeNull()
    // there are no funding rounds to aim at a target: the first form's target field is skipped, not kept, and the name after it still reads
    expect(parseProposal(`MOO:${MOO}:${ISSUER}:900:Moo Token`)).toEqual({ currency: MOO, issuer: ISSUER, name: 'Moo Token' })
    expect(parseProposal(JSON.stringify({ c: MOO, i: ISSUER, t: '900' }))).toEqual({ currency: MOO, issuer: ISSUER, name: undefined, image: undefined })
    expect(parseProposal('{nope')).toBeNull()
    expect(parseProposal('just-text')).toBeNull()
  })
  it('names the issuer the feed must read', () => {
    expect(proposalIssuer(memo({ c: MOO, i: ISSUER }))).toBe(ISSUER)
    expect(proposalIssuer(`propose:MOO:${MOO}:${ISSUER}`)).toBe(ISSUER)
    expect(proposalIssuer('round:MOO')).toBeNull()
  })
})

describe('keys', () => {
  it('gives the ticker when it is free and adds the issuer when it is not', () => {
    const tokens = base().tokens
    expect(keyFor(tokens, 'Moo', ISSUER)).toBe('MOO')
    expect(keyFor(tokens, 'PETAL', ISSUER)).toBe('PETAL.HB9C')
    tokens['PETAL.HB9C'] = { ...tokens.PETAL, sym: 'PETAL.HB9C' }
    expect(keyFor(tokens, 'PETAL', ISSUER)).toBe('PETAL.HB9CJA')
    expect(keyFor(tokens, '🌸', ISSUER)).toBe('TOKEN')
  })
})

describe('the issuer lane', () => {
  it('lists a token at once when its issuer pays the flat fee, with its name, logo and ticker', () => {
    const s = base()
    const ev = pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER, n: 'Moo Token', img: LOGO }), { from: ISSUER, issuerFlags: { ...signs, transferRate: 1_002_000_000, domain: 'moo.example' } })
    const { state, applied } = applyView(s, view(s, [ev]), NOW)
    expect(applied[0].kind).toBe('listing')
    expect(state.tokens.MOO).toMatchObject({ sym: 'MOO', ticker: 'MOO', name: 'Moo Token', image: LOGO, status: 'listed', lane: 'issuer', transferRate: 1_002_000_000, domain: 'moo.example', trustLine: 'pending', capUnits: '0', listedAt: NOW })
    expect(state.fees.xrp).toBe('50')
    expect(state.treasuryXrp).toBe('0')
    const trust = Object.values(state.actions).find((a) => a.reason.kind === 'trustline')!
    expect(trust.tx).toMatchObject({ TransactionType: 'TrustSet', Account: LOCK, LimitAmount: { currency: MOO, issuer: ISSUER } })
  })
  it('opens every lock-account line with NoRipple, so a same-code copy cannot be rippled through the lock', () => {
    const s = base()
    const ev = pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER, n: 'Moo Token' }), { from: ISSUER, issuerFlags: signs })
    const { state } = applyView(s, view(s, [ev]), NOW)
    const trust = Object.values(state.actions).find((a) => a.reason.kind === 'trustline')!
    // tfSetNoRipple, and nothing else that would change what the line means.
    expect((trust.tx as { Flags?: number }).Flags).toBe(0x00020000)
  })
  it('lists a second issuer\'s token with the same ticker under its own key', () => {
    const s = base()
    const ev = pay(FUND, xrp('50'), memo({ c: genesis.tokens.PETAL.currency, i: ISSUER, n: 'Another Petal' }), { from: ISSUER, issuerFlags: signs })
    const { state } = applyView(s, view(s, [ev]), NOW)
    expect(state.tokens['PETAL.HB9C']).toMatchObject({ ticker: 'PETAL', issuer: ISSUER, status: 'listed' })
    expect(state.tokens.PETAL.issuer).toBe(genesis.tokens.PETAL.issuer)
  })
  it('sends back an issuer that paid less than the listing fee', () => {
    const s = base()
    const ev = pay(FUND, xrp('5'), memo({ c: MOO, i: ISSUER }), { from: ISSUER, issuerFlags: signs })
    const { state } = applyView(s, view(s, [ev]), NOW)
    expect(state.unmatched.at(-1)?.reason).toBe('propose:fee')
    expect(state.tokens.MOO).toBeUndefined()
    expect((returnsTo(state, ISSUER)[0].tx as any).Amount).toBe('3999000')
    // a refusal keeps 1 XRP, as fee revenue
    expect(state.fees.xrp).toBe('1')
  })
})

describe('the cap a new listing takes', () => {
  const listed = (params: Record<string, string> = {}) => {
    const s = evmBase()
    s.config = { ...s.config, params: { ...s.config.params, ...params } }
    const ev = pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER, n: 'Moo' }), { from: ISSUER, issuerFlags: signs })
    return applyView(s, view(s, [ev]), NOW).state
  }
  it('is defaultCapUnits on the minter, and nothing can be locked until that listing has executed', () => {
    const s = listed()
    expect(s.tokens.MOO.capUnits).toBe('0')
    queueEvmWork(s, NOW)
    const list = Object.values(s.evmActions).find((a) => a.kind === 'list' && a.reason.kind === 'list' && a.reason.sym === 'MOO')!
    expect(list.data.dailyCap).toBe('100000000000000000000000')
  })
  it('follows defaultCapUnits, whatever the token\'s pool looks like', () => {
    const s = listed({ defaultCapUnits: '2500' })
    queueEvmWork(s, NOW)
    const list = Object.values(s.evmActions).find((a) => a.kind === 'list' && a.reason.kind === 'list' && a.reason.sym === 'MOO')!
    expect(list.data.dailyCap).toBe('2500000000000000000000')
  })
})

describe('a listing that opens by itself', () => {
  const UNCAPPED = (2n ** 256n - 1n).toString()
  const open = (s: State): State => {
    s.config = { ...s.config, params: { ...s.config.params, listingsOpen: true } }
    return s
  }
  const listedBy = (s: State, from: string, issuerFlags: IssuerFlags) => applyView(s, view(s, [pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER, n: 'Moo' }), { from, issuerFlags })]), NOW)
  const listAction = (s: State) => Object.values(s.evmActions).find((a) => a.kind === 'list' && a.reason.kind === 'list' && a.reason.sym === 'MOO')!
  /** The minter confirms the listing at the cap it was sent. */
  const minterConfirms = (s: State) => {
    const list = listAction(s)
    return applyEvmView(s, evmView(s, [{ kind: 'listed', tx: '0x' + '11'.repeat(32), block: s.cursor.evm!.block + 5, logIndex: 0, tokenId: list.data.tokenId, token: '0x' + '22'.repeat(20), dailyCapWei: list.data.dailyCap }]), NOW + 1000).state
  }
  /** A lock of MOO with its fee: where it ends up says whether the token takes deposits. */
  const lockMoo = (s: State, value = '250000000') => {
    const { state, transfer } = intent(s, { sym: 'MOO', amount: value })
    const next = applyView(state, view(state, [lockOf(transfer, { currency: MOO, issuer: ISSUER, value }), feeOf(transfer)]), NOW + 2000).state
    return next.transfers[transfer.id]
  }
  const ownsNothing: IssuerFlags = { ...lockedForGood, ownerCount: 0 }

  it('is off until an operator turns it on: either lane waits for a cap, as before', () => {
    for (const [from, flags] of [[ISSUER, signs], [ALICE, ownsNothing]] as const) {
      const { state, applied } = listedBy(evmBase(), from, flags)
      expect(state.tokens.MOO.autoOpen).toBeUndefined()
      expect(applied[0].detail).toMatch(/waits for an operator to set its cap/)
      queueEvmWork(state, NOW)
      expect(listAction(state).data.dailyCap).toBe(toWei(state.config.params.defaultCapUnits))
    }
  })
  it("opens the issuer's own listing: on the minter with no limit, and deposits once that listing lands", () => {
    const { state, applied } = listedBy(open(evmBase()), ISSUER, signs)
    expect(state.tokens.MOO).toMatchObject({ lane: 'issuer', autoOpen: true, capUnits: '0' })
    expect(applied[0].detail).toMatch(/opens by itself once its ERC-20 lands/)
    // nothing can be locked while the ERC-20 does not exist yet
    expect(lockMoo(state).failed).toBe('cap')
    queueEvmWork(state, NOW)
    expect(listAction(state).data.dailyCap).toBe(UNCAPPED)
    const live = minterConfirms(state)
    expect(live.tokens.MOO.capUnits).toBeUndefined()
    const t = lockMoo(live)
    expect(t.failed).toBeUndefined()
    expect(t.step).toBe(3)
  })
  it('opens a listing by anyone else when the issuer is locked for good and owns nothing', () => {
    const { state } = listedBy(open(evmBase()), ALICE, ownsNothing)
    expect(state.tokens.MOO).toMatchObject({ lane: 'community', autoOpen: true })
    queueEvmWork(state, NOW)
    expect(listAction(state).data.dailyCap).toBe(UNCAPPED)
    expect(minterConfirms(state).tokens.MOO.capUnits).toBeUndefined()
  })
  it('leaves a listing by anyone else to an operator when the issuer owns something (a Delegate entry could sign for it), or the read did not say', () => {
    for (const flags of [{ ...lockedForGood, ownerCount: 2 }, lockedForGood]) {
      const { state, applied } = listedBy(open(evmBase()), ALICE, flags)
      expect(state.tokens.MOO).toMatchObject({ lane: 'community', capUnits: '0' })
      expect(state.tokens.MOO.autoOpen).toBeUndefined()
      expect(applied[0].detail).toMatch(/waits for an operator/)
      queueEvmWork(state, NOW)
      expect(listAction(state).data.dailyCap).toBe(toWei(state.config.params.defaultCapUnits))
    }
  })
  it('leaves to an operator a payment from an issuer that looks locked for good: it can only have come through a Delegate entry', () => {
    const { state } = listedBy(open(evmBase()), ISSUER, { ...lockedForGood, ownerCount: 1 })
    expect(state.tokens.MOO).toMatchObject({ lane: 'issuer', capUnits: '0' })
    expect(state.tokens.MOO.autoOpen).toBeUndefined()
  })
  it('still refuses an issuer that can sign when someone else pays, open or not', () => {
    const { state, applied } = listedBy(open(base()), ALICE, { ...signs, ownerCount: 0 })
    expect(state.tokens.MOO).toBeUndefined()
    expect(applied[0].detail).toMatch(/propose:needs-issuer/)
  })
  it('one that opened can be shut by an operator like any other, and stays shut', () => {
    const { state } = listedBy(open(evmBase()), ISSUER, signs)
    queueEvmWork(state, NOW)
    const live = minterConfirms(state)
    live.config.admins = ['ed' + 'a'.repeat(64)]
    expect(applyAdmin(live, live.config.admins[0], { cmd: 'cap', sym: 'MOO', units: '0' }, NOW + 1500)).toMatchObject({ ok: true })
    expect(lockMoo(live).failed).toBe('cap')
    queueEvmWork(live, NOW + 1500)
    expect(Object.values(live.evmActions).find((a) => a.kind === 'update')!.data.dailyCap).toBe('0')
  })
})

describe('the community lane', () => {
  it('lists a token at once for anyone, for the issuer\'s fee, when its issuer is locked for good', () => {
    const s = base()
    const open = pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER, n: 'Moo' }), { issuerFlags: lockedForGood })
    const { state, applied } = applyView(s, view(s, [open]), NOW)
    expect(applied[0].kind).toBe('listing')
    expect(state.tokens.MOO).toMatchObject({ status: 'listed', lane: 'community', ticker: 'MOO', name: 'Moo', capUnits: '0', trustLine: 'pending', listedAt: NOW })
    // the paying account is not the issuer, and the fee is the same 50 XRP an issuer pays
    expect(state.fees.xrp).toBe('50')
    expect(Object.values(state.actions).find((a) => a.reason.kind === 'trustline')?.tx).toMatchObject({ TransactionType: 'TrustSet', LimitAmount: { currency: MOO, issuer: ISSUER } })
    expect(Object.keys(state)).not.toContain('rounds')
  })
  it('leaves the logo of a community listing to the operators: nobody can check a link a stranger names, and it is for good', () => {
    const s = base()
    const open = pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER, n: 'Moo', img: LOGO }), { issuerFlags: lockedForGood })
    const { state } = applyView(s, view(s, [open]), NOW)
    expect(state.tokens.MOO).toMatchObject({ status: 'listed', lane: 'community' })
    expect(state.tokens.MOO.image).toBeUndefined()
    // a link that is not a logo at all is still refused, in either lane
    const bad = pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER, img: 'http://logos.coin.com/x.png' }), { issuerFlags: lockedForGood })
    expect(applyView(s, view(s, [bad]), NOW).state.tokens.MOO).toBeUndefined()
  })
  it('keeps what a generous payer sent above the fee, as revenue', () => {
    const s = base()
    const { state } = applyView(s, view(s, [pay(FUND, xrp('120'), memo({ c: MOO, i: ISSUER }), { issuerFlags: lockedForGood })]), NOW)
    expect(state.tokens.MOO.status).toBe('listed')
    expect(state.fees.xrp).toBe('120')
    expect(returnsTo(state, ALICE)).toHaveLength(0)
  })
  it('wants the full listing fee: the old round fee is refused and sent back', () => {
    const s = base()
    const { state } = applyView(s, view(s, [pay(FUND, xrp('5'), memo({ c: MOO, i: ISSUER, n: 'Moo' }), { issuerFlags: lockedForGood })]), NOW)
    expect(state.unmatched.at(-1)?.reason).toBe('propose:fee')
    expect(state.tokens.MOO).toBeUndefined()
    expect(returnsTo(state, ALICE)).toHaveLength(1)
  })
  it('sends back a proposal for a token whose issuer can still sign', () => {
    const s = base()
    const { state } = applyView(s, view(s, [pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER }), { issuerFlags: signs })]), NOW)
    expect(state.unmatched.at(-1)?.reason).toBe('propose:needs-issuer')
    expect(returnsTo(state, ALICE)).toHaveLength(1)
    expect(state.tokens.MOO).toBeUndefined()
  })
  it('lists a token that was listed before as itself, never twice', () => {
    const s = base()
    const first = applyView(s, view(s, [pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER }), { issuerFlags: lockedForGood })]), NOW).state
    const again = applyView(first, view(first, [pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER }), { issuerFlags: lockedForGood, from: BOB })]), NOW)
    expect(again.state.unmatched.at(-1)?.reason).toBe('propose:exists')
    expect(Object.keys(again.state.tokens).filter((k) => k.startsWith('MOO'))).toEqual(['MOO'])
  })
})

describe('funding rounds are gone', () => {
  it('a round: payment is unmatched and sent back, whatever it names', () => {
    const s = base()
    const bySym = pay(FUND, xrp('40'), 'round:MOO')
    const byIdentity = pay(FUND, xrp('40'), `round:${MOO}:${ISSUER}`, { from: BOB })
    const { state, applied } = applyView(s, view(s, [bySym, byIdentity]), NOW)
    expect(applied.map((a) => a.kind).filter((k) => k !== 'action.pending')).toEqual(['round.retired', 'round.retired'])
    expect(state.unmatched.map((u) => u.reason)).toEqual(['round:retired', 'round:retired'])
    expect(returnsTo(state, ALICE).map((a) => (a.tx as any).Amount)).toEqual(['39999000'])
    expect(returnsTo(state, BOB).map((a) => (a.tx as any).Amount)).toEqual(['39999000'])
    expect(state.fees.xrp).toBe('0')
  })
  it('one too small to send back is kept and booked', () => {
    const s = base()
    const { state } = applyView(s, view(s, [pay(FUND, xrp('0.0005'), 'round:MOO')]), NOW)
    expect(returnsTo(state, ALICE)).toHaveLength(0)
    expect(state.fees.xrp).toBe('0.0005')
  })
  it('a round: payment is never a listing: a proposal that names a round-sized target lists at the flat fee', () => {
    const s = base()
    const { state } = applyView(s, view(s, [pay(FUND, xrp('50'), `propose:MOO:${MOO}:${ISSUER}:900:Moo`, { issuerFlags: lockedForGood })]), NOW)
    expect(state.tokens.MOO.status).toBe('listed')
    expect(state.fees.xrp).toBe('50')
  })
})

describe('what every proposal is refused for, and sent back', () => {
  const refused = (ev: XrplPaymentEvent) => {
    const s = base()
    const { state } = applyView(s, view(s, [ev]), NOW)
    expect(Object.keys(state.tokens)).toEqual(Object.keys(s.tokens))
    expect(returnsTo(state, ev.from)).toHaveLength(1)
    return state.unmatched.at(-1)?.reason
  }
  it('issuer settings that would trap tokens in the lock account', () => {
    expect(refused(pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER }), { from: ISSUER, issuerFlags: { ...signs, defaultRipple: false } }))).toBe('propose:no-default-ripple')
    expect(refused(pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER }), { from: ISSUER, issuerFlags: { ...signs, clawback: true } }))).toBe('propose:clawback')
    expect(refused(pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER }), { from: ISSUER, issuerFlags: null }))).toBe('propose:issuer-unread')
  })
  it('codes, logos and memos it cannot use', () => {
    expect(refused(pay(FUND, xrp('50'), memo({ c: '03B245BE580EC4F4386A751C084489EC4B514A2F', i: ISSUER }), { from: ISSUER, issuerFlags: signs }))).toBe('propose:lp-token')
    expect(refused(pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER, img: 'http://logos.coin.com/x.png' }), { from: ISSUER, issuerFlags: signs }))).toBe('propose:bad-image')
    expect(refused(pay(FUND, xrp('50'), 'propose:{"c":', { from: ISSUER, issuerFlags: signs }))).toBe('propose:bad-memo')
    expect(refused(pay(FUND, xrp('50'), memo({ c: genesis.tokens.PETAL.currency, i: genesis.tokens.PETAL.issuer }), { from: genesis.tokens.PETAL.issuer, issuerFlags: signs }))).toBe('propose:exists')
  })
})

describe('issuer metadata updates', () => {
  function listed(): State {
    const s = evmBase()
    const ev = pay(FUND, xrp('50'), memo({ c: MOO, i: ISSUER, n: 'Moo' }), { from: ISSUER, issuerFlags: signs })
    const st = applyView(s, view(s, [ev]), NOW).state
    st.tokens.MOO.evmAddress = '0x3333333333333333333333333333333333333333'
    st.tokens.MOO.capUnits = '100000'
    return st
  }
  it('takes a new name and logo from the issuer and carries them to the ERC-20 in one signed update', () => {
    const s = listed()
    const ev = pay(FUND, xrp('5'), `meta:${JSON.stringify({ c: MOO, n: 'Moo Finance', img: LOGO })}`, { from: ISSUER })
    const a = applyView(s, view(s, [ev]), NOW).state
    expect(a.tokens.MOO).toMatchObject({ name: 'Moo Finance', image: LOGO, metaVersion: 1 })
    const b = { ...a }
    const applied = queueEvmWork(b, NOW)
    const update = Object.values(b.evmActions).find((x) => x.kind === 'update')!
    expect(applied.map((x) => x.kind)).toContain('evm.update')
    expect(update.data).toEqual({ tokenId: tokenIdOf(b.tokens.MOO), name: 'Moo Finance', symbol: 'MOO', imageURI: LOGO, dailyCap: '100000000000000000000000', nonce: '1', version: '1' })
    // one at a time: nothing more is queued while it is pending
    expect(queueEvmWork(b, NOW).filter((x) => x.kind === 'evm.update')).toHaveLength(0)
    const updated = { kind: 'updated', tx: '0xupd', block: 1003, logIndex: 0, tokenId: tokenIdOf(b.tokens.MOO).toLowerCase(), token: b.tokens.MOO.evmAddress, dailyCapWei: '100000000000000000000000', nonce: '1' }
    const c = applyEvmView(b, evmView(b, [updated]), NOW).state
    expect(c.tokens.MOO).toMatchObject({ evmMetaNonce: 1, evmMetaVersion: 1 })
    expect(c.tokens.MOO.evmUpdateActionId).toBeUndefined()
    expect(c.evmActions[update.id].status).toBe('confirmed')
    expect(Object.values(c.evmActions).filter((x) => x.kind === 'update')).toHaveLength(1)
  })
  it('sends back an update from anyone but the issuer, an unchanged one and a bad logo', () => {
    const s = listed()
    const { state } = applyView(s, view(s, [
      pay(FUND, xrp('5'), `meta:${JSON.stringify({ c: MOO, n: 'Hijack' })}`, { from: BOB }),
      pay(FUND, xrp('5'), `meta:${JSON.stringify({ c: MOO, n: 'Moo' })}`, { from: ISSUER }),
      pay(FUND, xrp('5'), `meta:${JSON.stringify({ c: MOO, img: 'nope' })}`, { from: ISSUER }),
    ]), NOW)
    expect(state.unmatched.map((u) => u.reason)).toEqual(['meta:not-issuer', 'meta:unchanged', 'meta:bad-image'])
    expect(state.tokens.MOO.name).toBe('Moo')
    expect(state.tokens.MOO.metaVersion).toBeUndefined()
  })
  it('starts from the minter\'s own nonce when it adopts a listing it did not make', () => {
    const s = evmBase()
    const id = tokenIdOf(s.tokens.PETAL).toLowerCase()
    const r = applyEvmView(s, evmView(s, [], { [id]: { token: '0x4444444444444444444444444444444444444444', dailyCapWei: '0', metaNonce: '3' } }), NOW).state
    expect(r.tokens.PETAL.evmMetaNonce).toBe(3)
  })
})

describe('issuer transfer fees', () => {
  it('a release spends at most what it owes and delivers that less the issuer\'s fee', () => {
    const s = base()
    s.tokens.PETAL.lockedUnits = '1000'
    s.tokens.PETAL.transferRate = 1_002_000_000
    const { state, transfer, action } = createTestBurn(s, { sym: 'PETAL', amount: '100', to: ALICE, from: '0x' + '5'.repeat(40) }, 'feedfacefeedface', NOW)
    expect(transfer.receive).toBe('100')
    const tx = action.tx as any
    expect(tx.SendMax).toEqual({ currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '100' })
    expect(tx.Amount.value).toBe('99.8003991017964')
    // what it delivers, times the rate, never needs more than SendMax
    expect(Number(tx.Amount.value) * 1.002).toBeLessThanOrEqual(100)
    expect(state.transfers[transfer.id].deliver).toBe('99.8003991017964')
  })
  it('a token without a fee pays as before, with no SendMax', () => {
    const s = base()
    s.tokens.PETAL.lockedUnits = '1000'
    const { action, transfer } = createTestBurn(s, { sym: 'PETAL', amount: '100', to: ALICE, from: '0x' + '5'.repeat(40) }, 'feedfacefeedfac2', NOW)
    expect((action.tx as any).SendMax).toBeUndefined()
    expect(transfer.deliver).toBeUndefined()
  })
  it('a lock the cap sends back pays the fee out of itself too', () => {
    const { state: s, transfer } = intent(base())
    s.tokens.PETAL.capUnits = '10'
    s.tokens.PETAL.transferRate = 1_010_000_000
    const lock = lockOf(transfer, { currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value: '1000' })
    const { state } = applyView(s, view(s, [feeOf(transfer), lock]), NOW)
    const back = returnsTo(state, ALICE).find((a) => a.account === 'lock')!.tx as any
    expect(back.SendMax.value).toBe('1000')
    expect(Number(back.Amount.value)).toBeLessThan(1000 / 1.01)
  })
})

describe('issuer refreshes', () => {
  it('keeps the transfer fee current and pauses a token while its issuer has a global freeze on', () => {
    const s = base()
    const issuer = genesis.tokens.PETAL.issuer
    const a = applyView(s, view(s, [], { issuers: { [issuer]: { ...signs, transferRate: 1_005_000_000, globalFreeze: true, domain: 'petal.example' } } }), NOW)
    expect(a.state.tokens.PETAL).toMatchObject({ transferRate: 1_005_000_000, status: 'paused', frozen: true, domain: 'petal.example' })
    expect(a.applied.map((x) => x.kind)).toContain('token.paused')
    const b = applyView(a.state, view(a.state, [], { issuers: { [issuer]: signs } }), NOW)
    expect(b.state.tokens.PETAL.status).toBe('listed')
    expect(b.state.tokens.PETAL.frozen).toBeUndefined()
    expect(b.state.tokens.PETAL.transferRate).toBeUndefined()
  })
  it('never unpauses a token paused for another reason', () => {
    const s = base()
    s.tokens.PETAL.status = 'paused'
    const { state } = applyView(s, view(s, [], { issuers: { [genesis.tokens.PETAL.issuer]: signs } }), NOW)
    expect(state.tokens.PETAL.status).toBe('paused')
  })
})

describe('seeded tokens', () => {
  it('opens the lock account\'s trust line for a token the genesis seeds, once the account is known', () => {
    const s = base()
    s.tokens.SEED = { sym: 'SEED', ticker: 'SEED', name: 'Seed', issuer: ISSUER, currency: 'SED', status: 'listed', lane: 'genesis', lockedUnits: '0', dustUnits: '0' }
    expect(tick(s, NOW).applied.map((a) => a.kind)).not.toContain('trustline.queued')
    const known = applyView(s, view(s, []), NOW).state
    const t1 = tick(known, NOW)
    expect(t1.applied.filter((a) => a.kind === 'trustline.queued').map((a) => a.detail)).toEqual([`SEED (SED.${ISSUER.slice(0, 6)})`])
    expect(t1.state.tokens.SEED.trustLine).toBe('pending')
    expect(tick(t1.state, NOW).applied.map((a) => a.kind)).not.toContain('trustline.queued')
    // the test genesis tokens, whose setup opened their lines by hand, are left alone
    expect(t1.state.tokens.PETAL.trustLine).toBeUndefined()
  })
  it('sizes each line by the token\'s own supply, and a token that has none by the default', () => {
    const s = base()
    s.tokens.SEED = { sym: 'SEED', ticker: 'SEED', name: 'Seed', issuer: ISSUER, currency: 'SED', status: 'listed', lane: 'genesis', lockedUnits: '0', dustUnits: '0', trustLimit: '99980000000000' }
    s.tokens.PLAIN = { sym: 'PLAIN', ticker: 'PLN', name: 'Plain', issuer: BOB, currency: 'PLN', status: 'listed', lane: 'genesis', lockedUnits: '0', dustUnits: '0' }
    const known = applyView(s, view(s, []), NOW).state
    const queued = tick(known, NOW).state
    const limit = (sym: string) => (Object.values(queued.actions).find((a) => a.reason.kind === 'trustline' && (a.reason as { sym?: string }).sym === sym)?.tx as any)?.LimitAmount.value
    expect(limit('SEED')).toBe('99980000000000')
    expect(limit('PLAIN')).toBe(genesis.config.params.trustLineLimit)
  })
})

describe('issuer refresh turns', () => {
  it('reads at most six issuers per boundary and gets round to every one', () => {
    const s = base()
    const issuers = Array.from({ length: 13 }, (_, i) => `rIssuer${String(i).padStart(2, '0')}`)
    issuers.forEach((issuer, i) => (s.tokens[`T${i}`] = { sym: `T${i}`, name: `T${i}`, issuer, currency: 'ABC', status: 'listed', lockedUnits: '0', dustUnits: '0' }))
    // the dev genesis lists PETAL from an issuer of its own: 14 issuers, three turns
    const turns = [0, 1, 2, 3].map((n) => refreshTurn(s, n * 256))
    expect(turns.map((t) => t.length)).toEqual([6, 6, 2, 6])
    expect(new Set(turns.slice(0, 3).flat()).size).toBe(14)
    expect(turns[3]).toEqual(turns[0])
  })
})

describe('whether an issuer can freeze its token', () => {
  it('only when it has not set NoFreeze and someone can still sign for it', () => {
    expect(canFreeze({ noFreeze: false, blackholed: false })).toBe(true)
    expect(canFreeze({ noFreeze: true, blackholed: false })).toBe(false)
    // locked for good: a freeze is a transaction nobody can sign any more, NoFreeze or not (most meme issuers)
    expect(canFreeze({ noFreeze: false, blackholed: true })).toBe(false)
    expect(canFreeze({ noFreeze: true, blackholed: true })).toBe(false)
  })
  it('is what an issuer refresh writes, so a badge set by the old rule is corrected on the next read', () => {
    const s = base()
    const issuer = genesis.tokens.PETAL.issuer
    s.tokens.PETAL.noFreezeUnset = true
    const locked = applyView(s, view(s, [], { issuers: { [issuer]: { ...signs, noFreeze: false, disableMaster: true, blackholed: true } } }), NOW)
    expect(locked.state.tokens.PETAL.noFreezeUnset).toBe(false)
    expect(locked.state.tokens.PETAL.issuerLocked).toBe(true)
    const free = applyView(locked.state, view(locked.state, [], { issuers: { [issuer]: { ...signs, noFreeze: false } } }), NOW)
    expect(free.state.tokens.PETAL.noFreezeUnset).toBe(true)
    expect(free.state.tokens.PETAL.issuerLocked).toBeUndefined()
  })
})

describe('reading an issuer account', () => {
  const info = (account_data: Record<string, unknown>, extra: Record<string, unknown> = {}) => issuerFromAccountInfo({ account_data: { Flags: 0, ...account_data } as any, ...extra })
  it('calls an account locked for good only when nobody can sign for it again', () => {
    expect(info({ Flags: 0x00100000 }, { signer_lists: [] }).blackholed).toBe(true)
    expect(info({ Flags: 0x00100000, RegularKey: 'rrrrrrrrrrrrrrrrrrrrBZbvji' }, { signer_lists: [] }).blackholed).toBe(true)
    expect(info({ Flags: 0x00100000, RegularKey: BOB }, { signer_lists: [] }).blackholed).toBe(false)
    expect(info({ Flags: 0x00100000 }, { signer_lists: [{ SignerQuorum: 1 }] }).blackholed).toBe(false)
    expect(info({ Flags: 0x00100000, signer_lists: [{ SignerQuorum: 1 }] }).blackholed).toBe(false)
    expect(info({ Flags: 0 }, { signer_lists: [] }).blackholed).toBe(false)
  })
  it('keeps how many ledger objects the account owns: 0 rules out a Delegate entry that could sign for it', () => {
    expect(info({ Flags: 0x00100000, OwnerCount: 0 }, { signer_lists: [] })).toMatchObject({ blackholed: true, ownerCount: 0 })
    expect(info({ Flags: 0x00100000, OwnerCount: 2 }, { signer_lists: [] })).toMatchObject({ blackholed: true, ownerCount: 2 })
    // an answer without the field says nothing, rather than "owns nothing"
    expect(info({ Flags: 0x00100000 }, { signer_lists: [] }).ownerCount).toBeUndefined()
  })
  it('reads the transfer rate and the domain', () => {
    expect(info({ TransferRate: 1_002_000_000, Domain: Buffer.from('gatehub.net').toString('hex') })).toMatchObject({ transferRate: 1_002_000_000, domain: 'gatehub.net' })
    expect(info({}).transferRate).toBe(1_000_000_000)
    expect(info({ Flags: 0x80000000 | 0x00800000 })).toMatchObject({ clawback: true, defaultRipple: true })
  })
})
