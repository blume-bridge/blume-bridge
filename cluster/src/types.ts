/**
 * Consensus state. Everything here is written by every node identically; the
 * only way in is a user input that went through consensus, or a ledger view
 * that k operators agreed on (see vote.ts). Amounts are decimal strings.
 */

export interface Params {
  /** How the XRP fees split, in percent; the two add up to 100. */
  split: { operators: number; treasury: number }
  /** XRP an issuer pays to change its token's name or logo. */
  metaFeeXrp: string
  /** XRP to list a token: its issuer pays it, or anyone does for a token whose issuer is locked for good. Listed at once. Absent = DEFAULT_ISSUER_LISTING_FEE_XRP (listing.ts). */
  issuerListingFeeXrp?: string
  /** Fee on every multisigned XRPL transaction, in drops. Must cover (signers + 1) × base fee. */
  xrplFeeDrops: string
  /** A pending action must validate within this many ledgers of the window that created it, or it expires and is re-queued. */
  actionTtlLedgers: number
  /** Trust line limit the lock account sets for a listed token. */
  trustLineLimit: string
  /**
   * The daily mint cap a new listing is put on the minter with, in token units, unless it opens by itself (listingsOpen);
   * the lock cap follows once that listing executes. No price is read from any market, so this is a count of units and the
   * same for every token: a seed keeps the cap seed-build.ts priced offline, and an operator raises the rest as they prove
   * out. '0' in production: such a listing takes nothing until a cap is set.
   */
  defaultCapUnits: string
  /**
   * New listings open by themselves: put on the minter with no limit, like the day-one coins, so a token takes deposits as
   * soon as its ERC-20 exists. Only a listing the cluster can vouch for (machine.ts opensByItself); any other, and every
   * listing while this is absent, takes defaultCapUnits and waits for an operator. Set by `admin.ts listings open|wait`.
   */
  listingsOpen?: boolean
  /** A release the ledger refused (a tec code) or never validated is tried again this often, in ms of consensus time. Default 10 minutes. */
  releaseRetryMs?: number
  /** How long a refused release keeps being retried before the tokens are minted back to the burner on the EVM side, in ms of consensus time from the first failure. Default 24 hours. */
  releaseHoldMs?: number
  /** The flat fee for bridging in, in XRP, paid to the funding account with the lock's Batch or before it. Quoted per intent and pinned there. Nothing is ever taken from the bridged token. */
  feeXrp: string
  /** What a lock's sender pays, in XRP, with memo `return:<lock tx>`, to have a lock that never paid its fee sent back in full. Revenue like any fee. */
  returnFeeXrp: string
  /** How many intents one HotPocket user key may hold open at once (not the `from` it names, which a caller can change at will). Absent = DEFAULT_MAX_OPEN_INTENTS (machine.ts). */
  maxOpenIntents?: number
  /** How many intents all HotPocket user keys together may hold open: user keys cost nothing to make, so the per-key limit alone does not bound them. Absent = DEFAULT_MAX_OPEN_INTENTS_TOTAL. */
  maxOpenIntentsTotal?: number
  /** Operator payouts from XRP fees: one multisigned Batch from the funding account per period. Absent = no payouts. */
  payout?: {
    /** Ms of consensus time between payout batches. */
    everyMs: number
    /** Nothing is queued while the distributable XRP is below this. */
    minXrp: string
    /** A recipient's share accrues until it reaches this, so a first payout activates an unfunded address instead of bouncing. Default 1 (the reserve). */
    minShareXrp?: string
    /** Where the treasury share goes. Unset, or the funding account itself: the share stays in place. */
    treasuryAccount?: string
    /**
     * Where an operator's share goes when the operator published no payout address of its own. An Evernode instance cannot
     * publish one (nobody can write the file), and without this the share goes to the node's own key, which the host reads.
     * The funding account itself means keep it: the share stays in the account, owed to it, until something pays it out.
     * Absent = the node's own key address.
     */
    operatorPayout?: string
    /**
     * XRP the lock account keeps free above its reserve, to pay the fees on releases and returns and the reserve of
     * each new trust line. Each payout first tops it up to this out of the fees, before they are split; what the fees
     * cannot cover waits for the next period. Absent = the lock account is never topped up.
     */
    lockFloorXrp?: string
  }
}

export interface XrplConfig {
  /** JSON-RPC endpoints, tried in order. */
  rpc: string[]
  /** The SignerList account that holds every locked token. */
  lockAccount: string
  /** The SignerList account that takes the XRP fees (bridge in, listings, returns) and pays the operators out of them. */
  fundingAccount: string
  /** How many ledgers each agreed view covers. */
  windowLedgers: number
  /** A window is cut back to whole ledgers so a view carries at most this many events; a single ledger with more is proposed whole. Events are never dropped. */
  maxEventsPerView: number
  /** Ms between reads of the validated ledger index on one node. Windows still close in order; this only paces the polling. */
  pollMs: number
  /** Which kind of network this is, so an X-address made for the other kind is refused. Absent: not checked. */
  network?: 'mainnet' | 'test'
  /** Each node starts the server list at a point of its own, so one lying server cannot be believed by every node (feed/node.ts). Absent = true; false when the operator's own servers lead the list and the order is the point. */
  rotate?: boolean
}

export interface EvmConfig {
  rpc: string[]
  chainId: number
  /** The ThresholdMinter. Its factory deploys the tokens. */
  minter: string
  /** Blocks per agreed window. */
  windowBlocks: number
  /** Blocks behind the head a window must be before it is proposed. */
  confirmations: number
  /** As for XRPL, in whole blocks. */
  maxEventsPerView: number
  /** Ms between head reads on one node. */
  pollMs: number
  /** Explicit gas for relayed transactions; estimation is unreliable on the testnet. */
  gasLimit: number
  /** Consensus time a relayer gets before the next operator takes over, in ms. */
  relayTimeoutMs: number
  /** As for the XRP Ledger servers. */
  rotate?: boolean
}

export interface Config {
  /** Signatures needed. */
  k: number
  /** Operators in the signer set. */
  n: number
  /** The EVM side. Absent until Stage 3 configuration. */
  evm?: EvmConfig
  /**
   * The EVM side as far as it can be settled before the minter exists: everything but the minter. A cluster has to start
   * XRPL-only, because the minter's signers are its own nodes' EVM keys and those do not exist until the nodes have booted.
   * The operator command `evm` (src/admin.ts) adds the minter once it is deployed and turns the plan into `evm`.
   */
  evmPlan?: Omit<EvmConfig, 'minter'>
  /** Enables `test.burn`, a consensus input that fakes an EVM burn so a release can be tested before the EVM side exists. Never on mainnet. */
  testHooks?: boolean
  /** Where the nodes read the XRP Ledger from. 'fake' reads /tmp/bridge-feed.json on each node. */
  feed: 'fake' | 'xrpl'
  xrpl: XrplConfig
  params: Params
  /** Ms a transfer intent waits for its payment before it is dropped. */
  intentTtlMs: number
  /** HotPocket user public keys ('ed…', as `user.publicKey` shows them) allowed to send operator commands (src/admin.ts). None: nobody can, and a token listed with a cap of 0 stays closed. */
  admins?: string[]
}

export type TokenStatus = 'listed' | 'paused'

/** A node's public keys, published through the vote. */
export interface OperatorKeys {
  /** HotPocket node public key. */
  node: string
  xrplAddress: string
  xrplPublicKey: string
  evmAddress: string
  /** Where this operator's payout share is paid. Defaults to the node's own XRPL address. */
  payoutAddress?: string
}
/** By node public key. Complete when every UNL node is in it. */
export type Operators = Record<string, OperatorKeys>

export type ActionKind = 'xrpl.payment' | 'xrpl.trustset' | 'xrpl.batch'
export type ActionStatus = 'queued' | 'pending' | 'validated' | 'failed' | 'expired'
/** `return`: a payment the cluster could not use (a fee nothing can take, a lock over the cap or asked for back), sent back to whoever paid it, keyed by their tx. */
export type ActionReason = { kind: 'release'; transferId: string } | { kind: 'trustline'; sym: string } | { kind: 'return'; tx: string; to: string } | { kind: 'payout'; at: number }

/**
 * Something the cluster must sign. Created by the state machine from agreed
 * events, so every node holds the identical unsigned transaction; signatures
 * cross NPL and any node with k of them submits. Its fate comes back through
 * the ledger feed as an outgoing event with the same account and sequence.
 */
export interface ActionRec {
  id: string
  kind: ActionKind
  account: 'lock' | 'funding'
  tx: Record<string, unknown>
  status: ActionStatus
  reason: ActionReason
  attempts: number
  createdAt: number
  updatedAt: number
  sequence?: number
  lastLedger?: number
  hash?: string
  result?: string
  /** `xrpl.batch` only: one slot per inner transaction, in RawTransactions order. A batch is settled by these, never by the outer's result (the outer is tesSUCCESS even when the inners fail). */
  inner?: { sequence: number; hash?: string; result?: string }[]
}

/** What the cluster knows about one of its own accounts, from the agreed views. */
export interface AccountRec {
  sequence: number
  ledger: number
  /** Action currently holding this account's next sequence. */
  inflight?: string
  /** XRP balance in drops at `ledger`, for the payout balance floor. */
  balanceDrops?: string
}

export interface TokenRec {
  /** The key everything names the token by (requests, memos, fees): its ticker in capitals, with part of the issuer added when another listing already has it (listing.ts keyFor). */
  sym: string
  /** What people call it, decoded from the currency code. Absent on records from before tickers, where `sym` is the ticker. */
  ticker?: string
  name: string
  /** The logo exactly as the coin publishes it: an https:// link or an ipfs:// link (listing.ts parseImage). Nothing is uploaded. Carried to the ERC-20 as imageURI. */
  image?: string
  /** How it was listed: by its issuer for the flat fee, by anyone for the same fee when the issuer is locked for good, or in the genesis. */
  lane?: 'issuer' | 'community' | 'genesis'
  /** The issuer's TransferRate (1e9 = no fee), from the latest agreed read of its account. Releases pay it out of what they send. */
  transferRate?: number
  /** The issuer account's Domain, decoded. */
  domain?: string
  /** True while the issuer has a global freeze on: the token is paused until it lifts. */
  frozen?: boolean
  /** Metadata versions: bumped by each issuer update; the last one the ERC-20 carries; the minter's nonce for this token. */
  metaVersion?: number
  /** Paused by an operator command: no new inbound transfers and no new mints, burns and releases carry on. Separate from `status`, which an issuer's global freeze moves. */
  opPaused?: boolean
  evmMetaVersion?: number
  evmMetaNonce?: number
  /** The EVM update action carrying a metadata change, while it is pending. */
  evmUpdateActionId?: string
  /** r-address of the issuer, or 'native' for XRP. */
  issuer: string
  /** XRPL currency code as it appears on the ledger, absent for XRP. */
  currency?: string
  native?: boolean
  status: TokenStatus
  /** Lock cap in token units. Set at listing. Absent = uncapped (XRP). */
  capUnits?: string
  /** Token units that back the ERC-20 supply: locked for tokens that were minted, and fallen by every burn. A lock still waiting for its fee is not in it. */
  lockedUnits: string
  /** Surplus backing: what burns carried that the XRP Ledger cannot (18 decimals against 15 significant digits) stays in the lock account. Never revenue, never sold. */
  dustUnits: string
  /** True when the issuer can still freeze the token: it has NOT set NoFreeze and its account is not locked for good (machine.ts canFreeze). The name is older than the second half. */
  noFreezeUnset?: boolean
  /** True when the issuer account is locked for good (nobody can sign for it again): the supply is fixed, and it can never be frozen or charged a new fee. From the latest agreed read of the issuer. */
  issuerLocked?: boolean
  evmAddress?: string
  listedAt?: number
  /** The lock account's trust line to this token. */
  trustLine?: 'pending' | 'set' | 'failed'
  /**
   * The most that line takes: the token's own total supply, read from the ledger when the seed list was built (scripts/seed-build.ts,
   * gateway_balances), so the ledger never refuses a deposit the token could carry and never allows more than exists. Absent on a token
   * listed later, whose supply the cluster does not read: it gets params.trustLineLimit.
   */
  trustLimit?: string
  /** Consensus time the lock account's TrustSet for this token last failed, so it is tried again after an hour rather than every round. */
  trustLineFailedAt?: number
  /** Listed to open by itself (machine.ts opensByItself): the minter listing goes out with no limit, so deposits open when it lands. Absent = it waits for an operator to set a cap. */
  autoOpen?: true
  /** The EVM listing action, once queued. */
  evmActionId?: string
  /** The minter counts gross mints per UTC day; this mirrors its bucket so a lock the cluster accepts is one the minter will take. */
  mintDay?: number
  mintedToday?: string
}

export type EvmActionKind = 'mint' | 'list' | 'update'
export type EvmActionStatus = 'pending' | 'confirmed' | 'failed'
export interface EvmActionRec {
  id: string
  kind: EvmActionKind
  status: EvmActionStatus
  /** The typed-data message, as strings: Mint {tokenId,to,amount,srcTx}, List {tokenId,name,symbol,imageURI,dailyCap} or Update {tokenId,name,symbol,imageURI,dailyCap,nonce}. An update also carries `version`, the metadata version it brings, which is not signed. */
  data: Record<string, string>
  reason: { kind: 'mint'; transferId: string } | { kind: 'list'; sym: string } | { kind: 'update'; sym: string; nonce: number }
  /** Index into the sorted operator set of the node that relays. Rotates on timeout. */
  relayer: number
  /** Consensus time the current relayer took over. */
  relayAt: number
  attempts: number
  createdAt: number
  updatedAt: number
  hash?: string
}

export type Direction = 'in' | 'out'
export type TransferStep = 1 | 2 | 3 | 4 | 5

export interface TransferRec {
  id: string
  dir: Direction
  sym: string
  amount: string
  receive: string
  /** 1: an intent waiting for its payments. 2: inbound only, the lock is in and its fee is not, so nothing is minted yet (see `awaitingFee` on the read). 3: agreed, the mint is queued or in flight. 5: done. */
  step: TransferStep
  sigs: number
  sigsNeeded: number
  from: string
  to: string
  /** Outbound: the destination tag the release carries, from an X-address burn. */
  destTag?: number
  srcTx?: string
  dstTx?: string
  done: boolean
  /**
   * Why it ended without completing: 'expired' (an intent nobody paid), 'cap' (the lock and its fee went back),
   * 'returned' (inbound: the lock went back because its sender paid for `return:`; outbound: the tokens were minted
   * back), 'dust', or an EVM action that never confirmed. (A burn to something that is not an address is `held` with
   * result 'bad-destination' and ends 'returned'.)
   */
  failed?: string
  /** Memo a lock payment must carry to attach to this transfer. */
  memo?: string
  createdAt: number
  updatedAt: number
  /** Ledger the lock validated in. */
  srcLedger?: number
  /** The release (out) action, once queued. */
  actionId?: string
  /** The mint (in) EVM action, once queued. */
  evmActionId?: string
  /** For a lock sent back (the cap refused it, or its sender paid for `return:`): the action sending it back, and its hash once validated. */
  refundActionId?: string
  refundTx?: string
  /**
   * An outbound transfer whose release the ledger refused (a tec code) or that never validated. The burn is final,
   * the release is not: it is retried every releaseRetryMs until releaseHoldMs after the first failure, then the
   * tokens are minted back to `from`. `retryAt` is unset while a release action is open or once the return is queued.
   * `final`: no release could ever pay this (the destination is not an address), so the tokens go back without waiting out the hold.
   */
  held?: { since: number; result: string; attempts: number; retryAt?: number; final?: true }
  /** Outbound: the burn's log index in its transaction, which with `srcTx` is what a return mint is keyed by. */
  srcLog?: number
  /** The mint that gives a held transfer back on the EVM side, once queued; its tx once the Minted event confirms it. */
  returnEvmActionId?: string
  returnTx?: string
  /** The bytes32 source that mint is recorded under (from the burn tx and log index), which is how its Minted event finds this transfer. */
  returnKey?: string
  /** Inbound: the XRP fee due, pinned when the intent was quoted; once the fee payment attaches, what it paid. */
  feeXrp?: string
  /** Inbound: the payment that paid the fee, once attached. */
  feeTx?: string
  /** Inbound: who sent the lock payment, which is who `return:` has to come from. May differ from `from`, the account the intent named. */
  lockFrom?: string
  /** The HotPocket user key that asked for this intent, for as long as it is open: what the open-intent cap counts. */
  openedBy?: string
  /** Outbound, when the issuer charges a transfer fee: what the release delivers after it. `receive` is what leaves the lock account. */
  deliver?: string
}

export interface Cursor {
  xrpl: {
    /** Last ledger whose events are applied. */
    ledger: number
    /** Tx hashes applied recently. Replay guard. */
    seen: string[]
    /** How many events of the first position after `ledger` are already applied, when a flooded ledger is being worked through a view at a time (feed/window.ts). Absent = none. */
    skip?: number
  }
  evm?: {
    /** Last block whose events are applied. */
    block: number
    /** `tx:logIndex` applied recently. Replay guard. */
    seen: string[]
    /** How many events of the first block after `block` are already applied; see the XRP Ledger cursor. Absent = none. */
    skip?: number
    /** True once an agreed EVM window has been applied; listings are queued only after that. */
    synced?: boolean
  }
}

export interface Unmatched {
  tx: string
  ledger: number
  from: string
  to: string
  amount: Amount
  memo: string | null
  reason: string
  /** A payment into the lock account whose sender paid to have it sent back (`return:<tx>`): the action doing it. Marks the entry as spoken for, so it is returned once. */
  returned?: string
}

export interface Amount {
  /** 'XRP' or the ledger currency code. */
  currency: string
  issuer?: string
  /** XRP as XRP (not drops), IOUs as reported. */
  value: string
}

export interface State {
  config: Config
  tokens: Record<string, TokenRec>
  transfers: Record<string, TransferRec>
  operators: Operators
  actions: Record<string, ActionRec>
  evmActions: Record<string, EvmActionRec>
  /** By address: the lock and funding accounts. */
  accounts: Record<string, AccountRec>
  cursor: Cursor
  /** Payments the cluster could not attribute. Operators refund by hand for now. */
  unmatched: Unmatched[]
  /** The treasury's share of the fees that stays in the funding account because no treasury account is set. */
  treasuryXrp: string
  /** XRP fees taken, paid out, owed per recipient, and the payout history. */
  fees: FeesRec
  /** An operator paused the whole bridge: no new inbound transfers and no new mints; burns and releases carry on. */
  paused?: boolean
  /** The operator commands applied, newest last, capped. Lives in admin.json. */
  adminLog?: AdminLogEntry[]
}

/** One operator command, as it was applied. */
export interface AdminLogEntry {
  /** Consensus time. */
  at: number
  /** The first 12 characters of the user key that sent it. */
  by: string
  cmd: string
  args: Record<string, string>
  ok: boolean
  /** What happened, or why it was refused. */
  note: string
}

/**
 * XRP fees the bridge has taken (bridging in, returns, listings, name changes,
 * refusals), what has been paid out, what each recipient is still owed, and
 * every payout batch. Lives in fees.json.
 */
export interface FeesRec {
  /** XRP taken, total. */
  xrp: string
  /** The part of it that came from a token's own transfers and returns, by symbol. For reading; nothing pays out by it. */
  xrpByToken: Record<string, string>
  /** XRP paid out so far, the batches' own fees included. */
  paidXrp: string
  /** Shares accrued per recipient address that have not reached the minimum payout yet. */
  owed: Record<string, string>
  /** Consensus ms of the last payout batch queued. */
  lastPayoutAt?: number
  /** Every payout batch: the action, its total, and who got what. */
  payouts: { actionId: string; at: number; totalXrp: string; shares: { to: string; xrp: string; role: 'operator' | 'treasury' | 'lock'; hash?: string; result?: string }[] }[]
}

/** What a feed produces and the nodes vote on. */
export interface XrplPaymentEvent {
  kind: 'payment'
  tx: string
  ledger: number
  from: string
  to: string
  amount: Amount
  memo: string | null
  /** Filled by the feed when the memo is a proposal: the issuer's account at the window's last ledger, null when it could not be read. */
  issuerFlags?: IssuerFlags | null
  /** The outer Batch transaction's hash when this payment was an inner transaction of one (meta.ParentBatchID). */
  batch?: string
}

/** An issuer account as one agreed read found it. */
export interface IssuerFlags {
  noFreeze: boolean
  globalFreeze: boolean
  requireAuth: boolean
  clawback: boolean
  defaultRipple: boolean
  disableMaster: boolean
  /** TransferRate as the ledger stores it; 1e9 (or absent) = no fee. */
  transferRate?: number
  /** Master key off, no regular key (or one nobody holds), no signer list: nobody can ever sign for it again. */
  blackholed?: boolean
  domain?: string
  /** The ledger objects the account owns (OwnerCount). 0 means it owns no Delegate entry (XLS-75) through which another account could sign for it. Absent on reads from before it was kept. */
  ownerCount?: number
}

/** A transaction one of the cluster's own accounts sent, however it turned out. */
export interface XrplOutgoingEvent {
  kind: 'outgoing'
  tx: string
  ledger: number
  account: string
  type: string
  result: string
  sequence: number
  /** The payment's Destination and Amount as sent, so a transaction that merely took the sequence is not mistaken for ours. */
  destination?: string
  amount?: Amount
  /** The outer Batch's hash when this was an inner transaction of one. */
  batch?: string
  /** For an outer Batch: how many inner transactions it carried. */
  inner?: number
}

export type LedgerEvent = XrplPaymentEvent | XrplOutgoingEvent

export interface AccountSnap {
  sequence: number
  balanceDrops: string
}

export interface XrplView {
  src: 'xrpl'
  /** Cursor before this window. */
  from: number
  /** Last ledger of this window. Equal to `from` when only part of the next ledger fits (see `skip`): the cursor then does not move. */
  to: number
  /** Events of the first ledger after `from` that earlier views already carried; this view's events start after them. Absent = 0. */
  skip?: number
  events: LedgerEvent[]
  /** The lock and funding accounts as of ledger `to`. */
  accounts: Record<string, AccountSnap>
  /** Every listed token's issuer as of ledger `to`, read when the window crosses a refresh boundary (ISSUER_REFRESH_LEDGERS), so transfer fees and freezes stay current. */
  issuers?: Record<string, IssuerFlags>
}

/** Every node's public keys, proposed by a node that has heard all of them. */
export interface KeysView {
  src: 'keys'
  set: OperatorKeys[]
}

export type EvmEvent =
  | { kind: 'burn'; tx: string; block: number; logIndex: number; token: string; from: string; amountWei: string; rAddress: string; nonce: string }
  | { kind: 'mint'; tx: string; block: number; logIndex: number; tokenId: string; to: string; amountWei: string; srcTx: string }
  | { kind: 'listed'; tx: string; block: number; logIndex: number; tokenId: string; token: string; symbol: string; dailyCapWei: string }
  | { kind: 'updated'; tx: string; block: number; logIndex: number; tokenId: string; token: string; dailyCapWei: string; nonce: string }

export interface EvmView {
  src: 'evm'
  from: number
  /** Equal to `from` when only part of the next block fits (see `skip`): the cursor then does not move. */
  to: number
  /** Events of the first block after `from` that earlier views already carried. Absent = 0. */
  skip?: number
  events: EvmEvent[]
  /** Tokens the minter already lists that the state has no ERC-20 for: address, daily cap (wei) and metadata nonce, read at block `to`. By tokenId. On a v3 minter a cap of 0 means the token takes no mints and 2^256-1 (UNCAPPED in evm.ts) means no limit. */
  listings: Record<string, { token: string; dailyCapWei: string; metaNonce?: string }>
  /** Whether the minter has paused mints, read at block `to`. Every node reads the same block, so every node proposes the same value. Always set by the feed; optional only so older fixtures still type. */
  paused?: boolean
  /** The exit fee a burn must carry, in wei of XRP, read at block `to` like `paused`. Always set by the feed. */
  burnFee?: string
}

export type View = XrplView | KeysView | EvmView

/** One operator's EIP-712 signature over an EVM action, as it crosses NPL. */
export interface AttestMessage {
  a: string
  e: string
  s: `0x${string}`
}

/** One signer's part of a multisigned transaction, as it crosses NPL. */
export interface SignerEntry {
  Signer: { Account: string; SigningPubKey: string; TxnSignature: string }
}
export interface SigMessage {
  a: string
  s: SignerEntry
}
