import * as dec from './dec'
import { DEFAULT_ISSUER_LISTING_FEE_XRP } from './listing'
import { feeMemoOf, releaseHoldMs } from './machine'
import type { ActionRec, EvmActionRec, State, TokenRec, TransferRec } from './types'

/**
 * The message API, in the shapes bridge/src/lib/bridge/types.ts expects.
 * Reads are served from consensus state in read-only mode; the one input
 * (a transfer intent) goes through consensus. Numbers here are for the UI;
 * state keeps strings.
 */

const num = (s: string | undefined) => (s === undefined ? undefined : dec.toNumber(s))

/**
 * The cluster as the site needs to know it: who signs, the accounts to pay, and every fee the site quotes, as the
 * decimal strings the cluster keeps them in (the site turns them to drops exactly). `minter` and `evmChainId` are
 * what the burn is sent to and on; null on a cluster with no EVM side yet.
 */
export function toOperators(state: State) {
  const cfg = state.config
  return {
    k: cfg.k,
    n: cfg.n,
    ready: Object.keys(state.operators).length >= cfg.n,
    lockAccount: cfg.xrpl.lockAccount,
    fundingAccount: cfg.xrpl.fundingAccount,
    feeXrp: cfg.params.feeXrp,
    returnFeeXrp: cfg.params.returnFeeXrp,
    metaFeeXrp: cfg.params.metaFeeXrp,
    issuerListingFeeXrp: cfg.params.issuerListingFeeXrp ?? DEFAULT_ISSUER_LISTING_FEE_XRP,
    // New listings open by themselves (machine.ts opensByItself), so the listing sheet can say which a payment gets.
    listingsOpen: cfg.params.listingsOpen === true,
    minter: cfg.evm?.minter ?? null,
    evmChainId: cfg.evm?.chainId ?? null,
    // An operator paused the whole bridge: the site shows a banner and takes no new transfers.
    paused: state.paused === true,
    signers: Object.values(state.operators).map((o) => ({ node: o.node, xrplAddress: o.xrplAddress, xrplPublicKey: o.xrplPublicKey, evmAddress: o.evmAddress })),
  }
}

export function toBridgeToken(t: TokenRec) {
  return {
    sym: t.sym,
    ticker: t.ticker,
    name: t.name,
    image: t.image,
    native: t.native || undefined,
    issuer: t.issuer,
    currency: t.currency,
    lane: t.lane,
    domain: t.domain,
    transferRate: t.transferRate,
    status: t.status,
    // An operator paused this token (a pause by its issuer's global freeze shows in `status`).
    paused: t.opPaused === true || undefined,
    capUnits: num(t.capUnits),
    // Listed to open by itself: a cap of 0 on it means its ERC-20 is still being made, not that it waits for an operator.
    autoOpen: t.autoOpen || undefined,
    lockedUnits: dec.toNumber(t.lockedUnits),
    dustUnits: dec.toNumber(t.dustUnits),
    noFreezeUnset: t.noFreezeUnset || undefined,
    issuerLocked: t.issuerLocked || undefined,
    evmAddress: t.evmAddress,
    listedAt: t.listedAt,
    trustLine: t.trustLine,
    // What the token's own trust line allows (its total supply when it was listed): the site sizes a user's line by it when the ledger cannot be read.
    trustLimit: t.trustLimit,
  }
}

export function toAction(a: ActionRec, local?: { sigs: number; submitted?: { lcl: number; result?: string; hash?: string } }) {
  // A Batch has no Destination of its own: what it pays is in its inner transactions, and how each one went is in the action's slots.
  const raw = (a.tx as { RawTransactions?: { RawTransaction?: { Destination?: string } }[] }).RawTransactions
  return {
    id: a.id,
    kind: a.kind,
    account: a.account,
    status: a.status,
    reason: a.reason,
    attempts: a.attempts,
    sequence: a.sequence,
    lastLedger: a.lastLedger,
    hash: a.hash,
    result: a.result,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    destination: (a.tx as any).Destination,
    amount: (a.tx as any).Amount ?? (a.tx as any).LimitAmount,
    inner: a.inner,
    destinations: raw?.map((r) => r.RawTransaction?.Destination),
    sigs: local?.sigs ?? 0,
    submitted: local?.submitted,
  }
}

export function listActions(state: State, local: Record<string, { sigs: number; submitted?: { lcl: number; result?: string; hash?: string } }>) {
  return Object.values(state.actions)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, 50)
    .map((a) => toAction(a, local[a.id]))
}

export function toEvmAction(a: EvmActionRec, local?: { sigs: number; submitted?: { lcl: number; hash?: string; error?: string } }) {
  return { id: a.id, kind: a.kind, status: a.status, data: a.data, reason: a.reason, relayer: a.relayer, relayAt: a.relayAt, attempts: a.attempts, hash: a.hash, createdAt: a.createdAt, updatedAt: a.updatedAt, sigs: local?.sigs ?? 0, submitted: local?.submitted }
}

export function listEvmActions(state: State, local: Record<string, { sigs: number; submitted?: { lcl: number; hash?: string; error?: string } }>) {
  return Object.values(state.evmActions)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, 50)
    .map((a) => toEvmAction(a, local[a.id]))
}

/** The hold a refused release is under, as the UI shows it: what the ledger said, and when the tokens go back if nothing changes. */
function toHeld(t: TransferRec, holdMs: number) {
  if (!t.held) return undefined
  // A hold that is `final` has nothing left to wait out: the tokens go back as soon as the minter has room.
  return { result: t.held.result, since: t.held.since, until: t.held.final ? t.held.since : t.held.since + holdMs, attempts: t.held.attempts, returning: !!t.returnEvmActionId }
}

export function toTransfer(state: State, t: TransferRec, localSigs?: number) {
  const params = state.config.params
  // A lock that is in without its fee: what the app has to send to finish it, or to take the lock back.
  const waitingForFee = t.dir === 'in' && t.step === 2 && !t.failed && t.srcTx !== undefined
  return {
    id: t.id,
    dir: t.dir,
    sym: t.sym,
    amount: dec.toNumber(t.amount),
    receive: dec.toNumber(t.receive),
    deliver: num(t.deliver),
    step: t.step,
    sigs: t.done ? t.sigsNeeded : localSigs ?? t.sigs,
    sigsNeeded: t.sigsNeeded,
    from: t.from,
    to: t.to,
    srcTx: t.srcTx,
    dstTx: t.dstTx,
    done: t.done,
    failed: t.failed,
    held: toHeld(t, releaseHoldMs(state)),
    returnTx: t.returnTx,
    // Nothing that reads as "pay this" survives a failure: a client resuming by id must not be told to pay into an intent that expired or a lock the cap refused.
    memo: t.failed ? undefined : t.memo,
    feeXrp: num(t.feeXrp),
    // The fee payment once it has attached: the site's two-payment path waits for this before it asks for the lock.
    feeTx: t.feeTx,
    awaitingFee: waitingForFee
      ? { feeTo: state.config.xrpl.fundingAccount, feeMemo: feeMemoOf(t.id), feeXrp: t.feeXrp ?? params.feeXrp, returnMemo: `return:${t.srcTx}`, returnFeeXrp: params.returnFeeXrp }
      : undefined,
    actionId: t.actionId,
    evmActionId: t.evmActionId,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
}

/**
 * The cluster's answer to an intent: the transfer, the memo and the account the lock goes to, and for an inbound one the
 * fee exactly as it was pinned at the quote — where to pay it, the memo it carries, and its drops. The app puts the fee in
 * the same Batch as the lock, or sends it first.
 */
export function toIntentReply(state: State, t: TransferRec) {
  return {
    transfer: toTransfer(state, t),
    memo: t.memo,
    payTo: t.dir === 'in' ? state.config.xrpl.lockAccount : undefined,
    ...(t.dir === 'in' && t.feeXrp ? { feeTo: state.config.xrpl.fundingAccount, feeMemo: feeMemoOf(t.id), feeDrops: dec.toDrops(t.feeXrp) } : {}),
  }
}

export function listTokens(state: State) {
  return Object.values(state.tokens)
    .sort((a, b) => a.sym.localeCompare(b.sym))
    .map(toBridgeToken)
}

export function listTransfers(state: State, filter: { from?: string; to?: string; xrpl?: string; evm?: string }) {
  const wanted = [filter.from, filter.to, filter.xrpl, filter.evm].filter(Boolean).map((s) => String(s).toLowerCase())
  return Object.values(state.transfers)
    .filter((t) => !wanted.length || wanted.includes(t.from.toLowerCase()) || wanted.includes(t.to.toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, 100)
    .map((t) => toTransfer(state, t))
}
