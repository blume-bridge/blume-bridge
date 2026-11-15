import genesis from '../genesis/dev.json'
import * as dec from '../src/dec'
import { createIntent, feeMemoOf, validateIntent } from '../src/machine'
import type { ActionRec, State, TransferRec, XrplOutgoingEvent, XrplPaymentEvent, XrplView } from '../src/types'

/**
 * Builders every test file shares. The state is the dev genesis's config and
 * tokens with nothing in flight; the events are the ledger's own shapes.
 */

export const ALICE = 'rJfqVsXN3i6AD9ErSdNo98cyoKw6Euxj8K'
export const BOB = 'rpXzhnkZN2JArdmWAk3tmrtJwsErv963Na'
export const EVM = '0x5b7e0c3d1a9f4e2b8d6c7a1e3f5b9d2c4e6a8f1c'
export const NOW = 1788912000000
export const DAY = 86_400_000
export const LOCK = genesis.config.xrpl.lockAccount
export const FUND = genesis.config.xrpl.fundingAccount
export const MINTER = '0x36d8339a9d1bff3c37b5e6f5fc345223bf0d18e2'

export function baseState(): State {
  return {
    config: structuredClone(genesis.config) as State['config'],
    tokens: structuredClone(genesis.tokens) as State['tokens'],
    transfers: {},
    operators: {},
    actions: {},
    evmActions: {},
    accounts: {},
    cursor: structuredClone(genesis.cursor),
    unmatched: [],
    treasuryXrp: '0',
    fees: { xrp: '0', xrpByToken: {}, paidXrp: '0', owed: {}, payouts: [] },
  }
}

/** The same, with the EVM side configured, the cursor synced and the three operators known. */
export function evmState(): State {
  const s = baseState()
  s.config = { ...s.config, evm: { rpc: ['http://x'], chainId: 1449000, minter: MINTER, windowBlocks: 10, confirmations: 2, maxEventsPerView: 50, pollMs: 8000, gasLimit: 1500000, relayTimeoutMs: 60000 } }
  s.cursor.evm = { block: 1000, seen: [], synced: true }
  for (const n of ['edAAA', 'edBBB', 'edCCC']) s.operators[n] = { node: n, xrplAddress: 'r' + n, xrplPublicKey: 'ED' + n, evmAddress: '0x' + n.toLowerCase().padEnd(40, '0') }
  return s
}

/** The lock and funding accounts as a view's snapshot reports them: 100 and 125 XRP unless a test says otherwise. */
export const accounts = (lockSeq = 10, fundSeq = 20, lockDrops = '100000000', fundDrops = '125000000') => ({ [LOCK]: { sequence: lockSeq, balanceDrops: lockDrops }, [FUND]: { sequence: fundSeq, balanceDrops: fundDrops } })

export const xrp = (value: string) => ({ currency: 'XRP', value })
export const petal = (value = '1000') => ({ currency: genesis.tokens.PETAL.currency, issuer: genesis.tokens.PETAL.issuer, value })

// Hashes count up, so the event created first sorts first by hash: a test that needs the "wrong" hash order creates the events in that order.
let seq = 0
export function pay(to: string, amount: XrplPaymentEvent['amount'], memo: string | null, extra: Partial<XrplPaymentEvent> = {}): XrplPaymentEvent {
  seq++
  return { kind: 'payment', tx: `TX${String(seq).padStart(4, '0')}`, ledger: 102, from: ALICE, to, amount, memo, ...extra }
}
export function outgoing(account: string, sequence: number, result = 'tesSUCCESS', type = 'Payment', extra: Partial<XrplOutgoingEvent> = {}): XrplOutgoingEvent {
  seq++
  return { kind: 'outgoing', tx: `OUT${String(seq).padStart(4, '0')}`, ledger: 103, account, type, result, sequence, ...extra }
}
/** A lock payment's hash as the ledger writes it: 64 upper-case hex characters, which is what a `return:` memo has to name. */
export const hashOf64 = (n: number) => n.toString(16).toUpperCase().padStart(64, '0')

export const view = (s: State, events: (XrplPaymentEvent | XrplOutgoingEvent)[], acc = accounts()): XrplView => ({ src: 'xrpl', from: s.cursor.xrpl.ledger, to: s.cursor.xrpl.ledger + 5, events, accounts: acc })

/** An inbound intent for `amount` of a token from `from` to `to`, created at NOW. */
export function intent(s: State, opts: { id?: string; amount?: string; sym?: string; from?: string; to?: string; now?: number; openedBy?: string } = {}): { state: State; transfer: TransferRec } {
  const v = validateIntent(s, { dir: 'in', sym: opts.sym ?? 'PETAL', amount: opts.amount ?? '1000', from: opts.from ?? ALICE, to: opts.to ?? EVM }, opts.openedBy)
  if (!v.ok) throw new Error(v.error)
  return createIntent(s, v.intent, opts.id ?? 'feefeefeefeefee1', opts.now ?? NOW, opts.openedBy)
}
/** The fee payment for an intent: XRP to the funding account with the memo the cluster handed out. */
export const feeOf = (t: TransferRec, value = '1', extra: Partial<XrplPaymentEvent> = {}) => pay(FUND, xrp(value), feeMemoOf(t.id), extra)
/** The lock payment for an intent. */
export const lockOf = (t: TransferRec, amount: XrplPaymentEvent['amount'] = petal(), extra: Partial<XrplPaymentEvent> = {}) => pay(LOCK, amount, t.memo!, extra)

/** What leaves the funding account for an action: every payment's XRP and the network fee, whether it is plain or a Batch. */
export function leaves(a: ActionRec): string {
  const tx = a.tx as { Amount?: unknown; Fee?: string; RawTransactions?: { RawTransaction: { Amount?: unknown } }[] }
  const amounts = tx.RawTransactions ? tx.RawTransactions.map((r) => r.RawTransaction.Amount) : [tx.Amount]
  return amounts.reduce<string>((sum, amount) => (typeof amount === 'string' ? dec.add(sum, dec.fromDrops(amount)) : sum), dec.fromDrops(String(tx.Fee)))
}

/** The ledger executes everything the funding account has queued (but its payouts, which a test settles itself), one after another, and says what that cost. */
export function executeFundingActions(s: State): string {
  let out = '0'
  for (const a of Object.values(s.actions)) {
    if (a.account !== 'funding' || (a.status !== 'queued' && a.status !== 'pending') || a.reason.kind === 'payout') continue
    a.status = 'validated'
    out = dec.add(out, leaves(a))
  }
  if (s.accounts[FUND]) s.accounts[FUND].inflight = undefined
  return out
}
