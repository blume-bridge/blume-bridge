import type { TokenRec } from './types'

/**
 * What a listing is made of and the rules for each part, in one place. Pure:
 * the state machine applies these to agreed views, and the XRPL feed uses
 * parseProposal to know which issuer to read. The bridge UI keeps a copy of
 * the currency and name rules (bridge/src/lib/xrpl/currency.ts) so a proposal
 * it lets through is one the cluster accepts; this file is the authority.
 *
 * A token's identity is its currency code and issuer, read from the ledger.
 * The ticker people see is decoded from the code and never typed, because
 * anyone can mint a code that decodes to "RLUSD"; the name and logo are
 * decoration the issuer can change later.
 */

/** Accounts nobody holds a key to. A RegularKey set to one of them, with the master key off and no signer list, locks an account for good. */
export const BLACKHOLE_ADDRESSES = new Set(['rrrrrrrrrrrrrrrrrrrrrhoLvTp', 'rrrrrrrrrrrrrrrrrrrrBZbvji', 'rrrrrrrrrrrrrrrrrNAMEtxvNvQ', 'rrrrrrrrrrrrrrrrrrrn5RM1rHd'])

/** The XRPL TransferRate that means no fee; the field is absent or 0 when the issuer never set one. */
export const RATE_ONE = 1_000_000_000

/** What the issuer lane costs when the genesis predates the parameter. */
export const DEFAULT_ISSUER_LISTING_FEE_XRP = '50'

/** Characters the ledger allows in a 3-character code besides letters and digits. */
const STANDARD = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/
const HEX40 = /^[0-9A-Fa-f]{40}$/
/** A CID: version 0 (Qm…, base58) or version 1 in base32 (b…), then an optional path of plain file-name segments (never `.` or `..`). */
const CID = '(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})((?:/(?!\\.\\.?(?:/|$))[A-Za-z0-9._-]{1,100}){0,4})'
const IPFS_URI = new RegExp(`^ipfs://${CID}$`)
const IPFS_GATEWAY_URL = new RegExp(`^https://[A-Za-z0-9.-]{1,100}/ipfs/${CID}$`)
const CONTROL = /[\u0000-\u001F\u007F]/
const MAX_TICKER = 20
const MAX_NAME = 40
/** The minter refuses a name over 64 bytes or a symbol over 32 (BadMetadata). */
const NAME_BYTES = 64
const SYMBOL_BYTES = 32
/** MetaMask will not watch a token whose symbol is longer than this. */
const SYMBOL_CHARS = 11
/** A memo field longer than this is not a name, a code or an id. */
const FIELD_MAX = 256

export type Currency = { currency: string; ticker: string }

/**
 * The currency as the ledger reports it and the ticker it decodes to, or why
 * it cannot be listed. The ledger reports a standard code as its 3 characters
 * and anything else as 40 hex, so the hex form of a standard code is turned
 * back into the 3 characters: a token id hashed from the hex would never match
 * the locks. Demurrage codes (0x01) and AMM pool shares (0x03) are refused, as
 * is anything that does not decode to a short, printable ticker.
 */
export function normalizeCurrency(raw: unknown): Currency | { error: string } {
  const c = String(raw ?? '').trim()
  if (STANDARD.test(c)) return c.toUpperCase() === 'XRP' ? { error: 'xrp' } : { currency: c, ticker: c }
  if (!HEX40.test(c)) return { error: 'bad-currency' }
  const hex = c.toUpperCase()
  const bytes = Buffer.from(hex, 'hex')
  if (bytes[0] === 0x00) {
    const code = bytes.subarray(12, 15).toString('latin1')
    const zeros = bytes.subarray(0, 12).every((b) => b === 0) && bytes.subarray(15).every((b) => b === 0)
    if (!zeros || !STANDARD.test(code)) return { error: 'bad-currency' }
    return code.toUpperCase() === 'XRP' ? { error: 'xrp' } : { currency: code, ticker: code }
  }
  if (bytes[0] === 0x01) return { error: 'demurrage' }
  if (bytes[0] === 0x03) return { error: 'lp-token' }
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, end))
  const ticker = text.trim()
  if (!ticker || text.includes('�') || CONTROL.test(text) || [...ticker].length > MAX_TICKER) return { error: 'bad-ticker' }
  if (ticker.toUpperCase() === 'XRP') return { error: 'xrp' }
  return { currency: hex, ticker }
}

/** At most `chars` characters and `bytes` UTF-8 bytes, cut on a character boundary. */
function truncate(s: string, chars: number, bytes: number): string {
  let out = ''
  let n = 0
  for (const ch of s) {
    if (n >= chars || Buffer.byteLength(out + ch, 'utf8') > bytes) break
    out += ch
    n++
  }
  return out.trim()
}

/** A display name: control characters out, whitespace collapsed, at most 40 characters and what the minter takes; the ticker when nothing is left. */
export function cleanName(raw: unknown, fallback: string): string {
  const s = String(raw ?? '')
    .slice(0, FIELD_MAX)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return truncate(s, MAX_NAME, NAME_BYTES) || truncate(fallback, MAX_NAME, NAME_BYTES)
}

/**
 * The logo, carried as the coin publishes it. Nothing is uploaded, copied or stored anywhere: the ERC-20's `imageURI` is the
 * reference the issuer (or the list the token is on) already has. Two forms are taken:
 *  - IPFS, kept as `ipfs://<CID>[/path]`: the link a token launched on First Ledger (and many others) already has. Any
 *    gateway URL (`https://<host>/ipfs/<CID>...`) is turned into that form, so the reference does not depend on a gateway.
 *  - A web link, `https://<host>/<path>`, exactly as published (no rewriting): ASCII only, no credentials in it, a real
 *    domain name (not an IP address, `localhost` or an internal name), and short enough for the contract (256 bytes).
 * Anything else is not a logo. A web link is mutable: the host can change or lose the file, and every viewer's address
 * reaches that host. It is the coin's own, and an operator can set another (`admin.ts meta`).
 */
export function parseImage(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  const ipfs = IPFS_URI.exec(s) ?? IPFS_GATEWAY_URL.exec(s)
  if (ipfs) return ipfs[0].length <= FIELD_MAX ? `ipfs://${ipfs[1]}${ipfs[2] ?? ''}` : null
  return webImage(s)
}

/** A hostname that names a machine somewhere on the internet: a dotted name, not an address and not a local or internal name. */
function publicHostName(host: string): boolean {
  if (!host.includes('.') || host.startsWith('[')) return false
  if (/^[0-9.]+$/.test(host)) return false // an IPv4 address
  return !/(^|\.)(localhost|local|internal|lan|home|corp|intranet|test|invalid|example)$/i.test(host)
}

function webImage(s: string): string | null {
  if (s.length === 0 || s.length > FIELD_MAX || /[^\x21-\x7e]/.test(s)) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || !publicHostName(u.hostname)) return null
  return s
}

/** The ERC-20's symbol: the ticker, cut to what MetaMask will watch and the minter will take. */
export function erc20Symbol(t: Pick<TokenRec, 'ticker' | 'sym'>): string {
  return truncate(t.ticker ?? t.sym, SYMBOL_CHARS, SYMBOL_BYTES) || t.sym.slice(0, SYMBOL_CHARS)
}

/** The ERC-20's name, within what the minter takes. */
export function erc20Name(t: Pick<TokenRec, 'name' | 'ticker' | 'sym'>): string {
  return truncate(t.name, MAX_NAME, NAME_BYTES) || erc20Symbol(t)
}

export interface ProposalSpec {
  currency: string
  issuer: string
  name?: string
  /** As written in the memo; parseImage decides whether it is a logo. Absent when the memo named none. */
  image?: string
}

const field = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v).slice(0, FIELD_MAX))
/** A logo link, kept whole: cutting a long one to FIELD_MAX would make a different, valid-looking link. parseImage refuses what is too long. */
const imageField = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v).slice(0, 2048))

/**
 * What a `propose:` memo asks for. The current form is JSON,
 * `{"c":currency,"i":issuer,"n":name,"img":logoLink}`; the first form,
 * `SYM:CURRENCY:ISSUER[:TARGET[:NAME…]]`, is still read, but its typed symbol
 * is ignored now that the ticker comes from the currency code, and so is its
 * target (and a `t` in the JSON): there are no funding rounds to aim at one.
 * Null when the memo is neither.
 */
export function parseProposal(spec: string): ProposalSpec | null {
  const s = String(spec ?? '').trim()
  if (s.startsWith('{')) {
    let j: unknown
    try {
      j = JSON.parse(s)
    } catch {
      return null
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null
    const o = j as Record<string, unknown>
    return { currency: field(o.c)?.trim() ?? '', issuer: field(o.i)?.trim() ?? '', name: field(o.n), image: imageField(o.img) }
  }
  const [, currency, issuer, , ...name] = s.split(':')
  if (currency === undefined || issuer === undefined) return null
  return { currency: currency.trim(), issuer: issuer.trim(), name: name.join(':').trim() || undefined }
}

/** The issuer a memo's proposal names, so the feed can read its account at the window's ledger. Null when the memo is no proposal. */
export function proposalIssuer(memo: string | null): string | null {
  const m = String(memo ?? '').trim()
  if (!/^propose:/i.test(m)) return null
  return parseProposal(m.slice(8))?.issuer || null
}

export interface MetaSpec {
  currency: string
  name?: string
  image?: string
}

/** What a `meta:` memo from an issuer asks to change: `{"c":currency,"n":name,"img":logoLink}`. An absent field stays as it is; an empty `img` removes the logo. */
export function parseMeta(spec: string): MetaSpec | null {
  let j: unknown
  try {
    j = JSON.parse(String(spec ?? '').trim())
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  return { currency: field(o.c)?.trim() ?? '', name: field(o.n), image: imageField(o.img) }
}

/**
 * The key a new listing is stored under: what requests, memos and URLs name.
 * Its ticker in capitals when that is free, otherwise the ticker and as much
 * of the issuer as it takes to be unique, so two issuers' USD can both be
 * listed and neither can take the other's place. People see the ticker, not
 * the key. A key is never taken over from another token, even a refunded one:
 * its record is the history of that round.
 */
export function keyFor(tokens: Record<string, TokenRec>, ticker: string, issuer: string): string {
  const base = ticker.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'TOKEN'
  const free = (k: string) => !tokens[k]
  if (free(base)) return base
  const id = issuer.slice(1).toUpperCase()
  for (let n = 4; n <= id.length; n += 2) {
    const k = `${base}.${id.slice(0, n)}`
    if (free(k)) return k
  }
  for (let i = 2; ; i++) if (free(`${base}.${id}.${i}`)) return `${base}.${id}.${i}`
}
