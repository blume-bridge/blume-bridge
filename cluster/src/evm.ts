import { createPublicClient, createWalletClient, defineChain, fallback, http, keccak256, parseAbi, stringToBytes, type Address, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { EvmConfig, TokenRec } from './types'

/**
 * The EVM side, shared by the feed (reads), the attestations (typed data)
 * and the relay (writes). Everything the contract in contracts/src/bridge
 * expects, spelled once.
 */

/** A daily cap of this value means no limit; a cap of 0 means the token takes no mints (minter v3). */
export const UNCAPPED = 2n ** 256n - 1n
/** The exit fee can never be set above this, in wei of XRP. */
export const MAX_BURN_FEE = 10n ** 18n

// The minter's custom errors are listed so a revert decodes by name (viem reads them from the ABI it is given).
export const MINTER_ABI = parseAbi([
  'function mint((bytes32 tokenId, address to, uint256 amount, bytes32 srcTx) m, bytes[] sigs)',
  'function listToken((bytes32 tokenId, string name, string symbol, string imageURI, uint256 dailyCap) l, bytes[] sigs) returns (address)',
  'function updateToken((bytes32 tokenId, string name, string symbol, string imageURI, uint256 dailyCap, uint256 nonce) u, bytes[] sigs)',
  'function pause()',
  'function resume(uint256 nonce, bytes[] sigs)',
  'function setBurnFee((uint256 burnFee, uint256 nonce) f, bytes[] sigs)',
  'function sweep((address[] to, uint256[] amounts, uint256 nonce) s, bytes[] sigs)',
  'function tokens(bytes32 tokenId) view returns (address)',
  'function isToken(address token) view returns (bool)',
  'function isSigner(address account) view returns (bool)',
  'function caps(address token) view returns (uint256 perDay, uint256 used, uint256 day)',
  'function metaNonce(bytes32 tokenId) view returns (uint256)',
  'function minted(bytes32 srcTx) view returns (bool)',
  'function signers() view returns (address[])',
  'function threshold() view returns (uint8)',
  'function burnFee() view returns (uint256)',
  'function feeNonce() view returns (uint256)',
  'function sweepNonce() view returns (uint256)',
  'function resumeNonce() view returns (uint256)',
  'function paused() view returns (bool)',
  'function domainSeparator() view returns (bytes32)',
  'function MAX_BURN_FEE() view returns (uint256)',
  'function UNCAPPED() view returns (uint256)',
  'event Minted(bytes32 indexed tokenId, address indexed to, uint256 amount, bytes32 indexed srcTx)',
  'event Listed(bytes32 indexed tokenId, address indexed token, string name, string symbol, string imageURI, uint256 dailyCap)',
  'event Updated(bytes32 indexed tokenId, address indexed token, string name, string symbol, string imageURI, uint256 dailyCap, uint256 nonce)',
  'event BurnFeeSet(uint256 oldFee, uint256 newFee)',
  'event Swept(address[] to, uint256[] amounts, uint256 nonce)',
  'event Paused(address by)',
  'event Resumed(uint256 nonce)',
  'error BadSignerSet()',
  'error NotEnoughSignatures()',
  'error BadSignature()',
  'error SignersNotSorted()',
  'error UnknownToken()',
  'error TokenExists()',
  'error AlreadyMinted()',
  'error CapExceeded()',
  'error NoPendingRotation()',
  'error RotationNotReady()',
  'error BadNonce()',
  'error BadSeq()',
  'error BadMetadata()',
  'error BadFee()',
  'error NotToken()',
  'error BadSweep()',
  'error SweepFailed()',
  'error IsPaused()',
  'error AlreadyPaused()',
  'error NotPaused()',
  'error NotSigner()',
  // OpenZeppelin's ECDSA, for a signature that is not even well formed.
  'error ECDSAInvalidSignature()',
  'error ECDSAInvalidSignatureLength(uint256 length)',
  'error ECDSAInvalidSignatureS(bytes32 s)',
])

export const TOKEN_ABI = parseAbi([
  'event Burn(address indexed from, uint256 amount, string rAddress, uint256 indexed nonce)',
  'function balanceOf(address owner) view returns (uint256)',
  // payable: msg.value must equal the minter's burnFee() exactly.
  'function burn(uint256 amount, string rAddress) payable returns (uint256)',
  'error BadFeePayment()',
  'error FeeTransferFailed()',
  'error BadAddress()',
  'error BadAmount()',
  'error NotMinter()',
])

export const TYPES = {
  Mint: [
    { name: 'tokenId', type: 'bytes32' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'srcTx', type: 'bytes32' },
  ],
  List: [
    { name: 'tokenId', type: 'bytes32' },
    { name: 'name', type: 'string' },
    { name: 'symbol', type: 'string' },
    { name: 'imageURI', type: 'string' },
    { name: 'dailyCap', type: 'uint256' },
  ],
  Update: [
    { name: 'tokenId', type: 'bytes32' },
    { name: 'name', type: 'string' },
    { name: 'symbol', type: 'string' },
    { name: 'imageURI', type: 'string' },
    { name: 'dailyCap', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
  SetBurnFee: [
    { name: 'burnFee', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
  Sweep: [
    { name: 'to', type: 'address[]' },
    { name: 'amounts', type: 'uint256[]' },
    { name: 'nonce', type: 'uint256' },
  ],
  Resume: [{ name: 'nonce', type: 'uint256' }],
} as const

/** Version 3 is the minter with the exit fee, sweeps, the pause and a cap of 0 meaning no mints; a signature made for an older version never verifies. */
export function domain(cfg: EvmConfig) {
  return { name: 'BlumeBridge', version: '3', chainId: cfg.chainId, verifyingContract: cfg.minter as Hex } as const
}

/**
 * The three messages k signers sign for the operator-run actions (setBurnFee,
 * sweep, resume), as typed data ready for `signTypedData` and `hashTypedData`.
 * The nonce is the minter's own counter for that action (feeNonce, sweepNonce,
 * resumeNonce), read when the message is about to be sent: a signed message
 * never expires, it is good for exactly one call until its nonce is spent.
 */
export function setBurnFeeTyped(cfg: EvmConfig, burnFee: bigint, nonce: bigint) {
  return { domain: domain(cfg), types: TYPES, primaryType: 'SetBurnFee' as const, message: { burnFee, nonce } }
}
export function sweepTyped(cfg: EvmConfig, to: readonly Address[], amounts: readonly bigint[], nonce: bigint) {
  return { domain: domain(cfg), types: TYPES, primaryType: 'Sweep' as const, message: { to: [...to], amounts: [...amounts], nonce } }
}
export function resumeTyped(cfg: EvmConfig, nonce: bigint) {
  return { domain: domain(cfg), types: TYPES, primaryType: 'Resume' as const, message: { nonce } }
}

/** The bytes32 id the minter keys tokens by. Deterministic from the XRPL identity. */
export function tokenIdOf(t: Pick<TokenRec, 'native' | 'currency' | 'issuer'>): Hex {
  return keccak256(stringToBytes(t.native ? 'XRP:native' : `${t.currency}:${t.issuer}`))
}

/** A transaction hash (an XRPL hash, 64 hex, or an EVM hash with its 0x) as the bytes32 the minter records a mint's source under. */
export function srcTxOf(hash: string): Hex {
  return `0x${hash.toLowerCase().replace(/^0x/, '').padStart(64, '0')}` as Hex
}

/**
 * The source a return mint is recorded under: the burn it gives back, by its transaction AND its log index. The minter
 * mints once per source, and one EVM transaction can hold several burns (a router burning for two users, a script
 * burning twice), so the transaction hash alone would let the first return use up the second's. Hashing a tagged string
 * keeps it clear of every XRPL hash an inbound mint is keyed by.
 */
export function returnSrcTxOf(burnTx: string, logIndex: number): Hex {
  return keccak256(stringToBytes(`return:${burnTx.toLowerCase()}:${logIndex}`))
}

export function chainOf(cfg: EvmConfig) {
  return defineChain({
    id: cfg.chainId,
    name: 'XRPL EVM',
    nativeCurrency: { name: 'XRP', symbol: 'XRP', decimals: 18 },
    rpcUrls: { default: { http: cfg.rpc } },
    // Canonical Multicall3, deployed on XRPL EVM (code verified on the testnet 2026-09-09). Lets one call read many contracts at a pinned block.
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  })
}

/**
 * Every endpoint in `cfg.rpc`, in order. A call that one endpoint refuses (a 403
 * ban, a 5xx, a timeout) goes on to the next at once; a call every endpoint
 * refused is tried again `retryCount` times. A revert is the contract's answer,
 * not the endpoint's: viem hands it straight back without asking another
 * endpoint or retrying. `timeoutMs` is per endpoint, so a view with a tight
 * budget passes `retryCount` 0. Each `http` makes one attempt (retryCount 0) so
 * that an endpoint that is refusing us is not asked three more times first.
 */
function transportOf(cfg: EvmConfig, timeoutMs: number, retryCount: number) {
  if (!cfg.rpc.length) throw new Error('evm.rpc lists no endpoint')
  return fallback(
    cfg.rpc.map((url) => http(url, { timeout: timeoutMs, retryCount: 0 })),
    { retryCount },
  )
}

// cacheTime 0: a block number is never served from the client's cache, so a head read right after a log read is the head at that moment.
export function publicClient(cfg: EvmConfig, timeoutMs: number, retryCount = 1): PublicClient {
  return createPublicClient({ chain: chainOf(cfg), transport: transportOf(cfg, timeoutMs, retryCount), cacheTime: 0 })
}

export function walletClient(cfg: EvmConfig, privateKey: Hex, timeoutMs: number, retryCount = 1) {
  const account = privateKeyToAccount(privateKey)
  return { account, client: createWalletClient({ account, chain: chainOf(cfg), transport: transportOf(cfg, timeoutMs, retryCount) }) }
}
