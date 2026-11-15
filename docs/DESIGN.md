# Design

How the bridge works, why it is built this way, and what it does not protect against yet. The code cites some of the numbered decisions below.

## The pieces

- **Lock account (XRP Ledger).** Holds a trust line to every listed token, each set with NoRipple so one token's backing can never be swapped out through another with the same currency code. Controlled by a SignerList: the n node keys, quorum k.
- **Funding account (XRP Ledger).** Takes the XRP fees and listing payments, and pays the operators and the treasury (70/30, daily, as one multisigned Batch).
- **TokenFactory and BridgeToken (EVM).** One ERC-20 per listed token. `burn(amount, rAddress)` carries the XRP Ledger destination. A burn pays a small exit fee in the chain's native coin, capped in the contract.
- **ThresholdMinter (EVM).** Mints when it holds k valid EIP-712 signatures from the current node set. No owner and no proxy. One signer can pause mints; a cap of 0 means no mints for that token.
- **The cluster.** n HotPocket instances running one contract (`cluster/src/contract.ts`). It keeps tokens, transfers, fees and payouts in consensus state, reads both chains, and signs for both.

## A transfer, step by step

**In (XRP Ledger to EVM).** The user asks the cluster for an intent (a HotPocket input). The cluster answers with a memo, the lock account and the fee. The user pays the fee and the lock, in one Batch or separately. Every node sees both payments validate, the nodes agree on that view, each signs an attestation, and one node relays the mint with k signatures. A lock that arrives without its fee waits for it, and its sender can ask for it back.

**Out (EVM to XRP Ledger).** The user burns the ERC-20 with an r-address. Every node sees the burn finalize, they agree, they each sign the release payment, and the multisigned payment is submitted. If the release fails on the ledger after the burn is final (no trust line, a destination tag required, a deleted account), it is held, retried, and finally minted back. The app checks the destination before it lets anyone burn.

## Inside the cluster

**Agreeing on what happened.** HotPocket runs the contract every round (about 3 s here). Reading a ledger is not deterministic, so a node never acts on its own read. Each node reads fixed windows of validated ledgers from public RPC servers and broadcasts its view over NPL (HotPocket's node-to-node messages). The contract applies a window only when k nodes broadcast byte-identical views. Windows are proposed only once fully validated, so honest nodes with the same history propose the same bytes. A feed never drops an event: a window ends early on a whole ledger instead of slicing it, because slicing once opened a double-release path.

**Signing.** Each node generates its XRP Ledger and EVM keys into its own non-consensus directory at first boot and publishes the public halves. Signatures are collected over NPL and a transaction is submitted once k are in hand. What a node keeps and what the host can see is in [cluster/KEYS.md](../cluster/KEYS.md).

**Reads.** Any node answers read-only requests (`status`, `tokens`, `transfer`, `operators` and more) over HotPocket's WebSocket. Browsers reach the nodes through a small relay that terminates TLS and checks each node's certificate (`cluster/scripts/front-door/`).

**Watching from outside.** `cluster/scripts/watchdog.ts` runs on a machine that is not a node, needs no keys, and alerts when something needs a human: a node behind, a stuck transfer, a lock account holding less than the ERC-20 supply. See [cluster/WATCHDOG.md](../cluster/WATCHDOG.md).

## Decisions the code cites

**Decision 3: hosts can read keys.** An Evernode host can read everything inside an instance on its machine, keys included. So no single host, and no single provider, may hold k or more of the instances. `scripts/evernode-hosts.ts` and `scripts/evernode-spread.ts` enforce it when the cluster is leased (one host at a time, because the stock tooling put two instances on one host). This is the main reason the roadmap wants keys that no host can read.

**Decision 36: code can change, and who can change it.** An Evernode instance takes exactly one bundle. After that, a defect would mean a new cluster, new keys, new SignerLists and a new minter. So the bundle is a small fixed loader (`src/loader-core.ts`) that runs a replaceable app, and any key in `UPGRADE_KEYS` can push a new app. The nodes then agree on it like anything else, with rollback if the new version will not load. Whoever holds an upgrade key can change what the nodes sign, so today the upgrade key is the most powerful key in the system. See [BRIDGE_UPGRADES.md](BRIDGE_UPGRADES.md).

**Decision 39: liveness has to match safety.** HotPocket's default consensus threshold is 80%. With three nodes that means all three must agree to close a round, while only two are needed to sign. A cluster that should survive one node down would stall instead (it did, in a rehearsal on real hosts). The cluster is created with the threshold set from k and n, so k nodes are enough to close rounds, and leasing is not finished until the cluster has formed (`scripts/lib/formation.ts`).

**Decision 41: master keys stay on until there is a recovery signer.** Disabling the lock account's master key makes the SignerList the only way in. If the cluster were lost (two lapsed leases is enough), nobody could ever sign for the locked tokens. Until a recovery signer sits on both SignerLists, the master keys stay on and `preflight.ts` warns about it.

## Fees

Flat and in XRP: 1 XRP to bridge in (anyone can sponsor it), 0.25 XRP to bridge back, 50 XRP for an issuer to list. Split 70% to operators and 30% to a treasury, paid daily. The bridged token is never taken as a fee: it would have to be sold some day, which is sell pressure on the token and a liability on the cluster.

## Listings

An issuer lists its own token by paying the listing fee with a `propose:` memo. The ERC-20 is deployed with the name and logo link the issuer gives, and the listing opens by itself. Anyone can propose a token whose issuer is locked for good, but it opens by itself only if the issuer account owns no ledger objects, because a Delegate entry can still sign for a "blackholed" account. Anything else waits for an operator to open it.

## Limits and known risks

| Risk | Where it stands |
|---|---|
| One person holds the upgrade key, the master keys and every lease | True today. The roadmap removes them in order |
| Hosts can read keys | No host holds k or more instances (Decision 3). Real fix: keys no host can read |
| A lapsed lease erases the instance and its keys, with no grace period | Leases are renewed by hand (`scripts/evernode-extend.sh`). An expiry alert, off-instance state copies and node replacement are not built |
| An instance cannot be restarted from outside | If a host's machine goes down, only that host can bring the instance back. With 2 of 3, a second loss stops the bridge until it is fixed (funds stay locked, not lost) |
| Every node reads the same public RPC servers | Several XRP Ledger servers per node, cached answers. XRPL EVM has one public RPC server, so a lying or down server there affects every node |
| A ledger with more events than one round can carry | Proposed whole; a too-large message delays that round only |
| Issuer freezes a listed token's trust line | A global freeze pauses that token until it lifts |

## What is proven

On XRPL Devnet and Testnet: full round trips, a 270-payment flood, redeploys that carry state over, held releases that retry and mint back, issuer listings. On three real Evernode instances on three hosts: cross-host NPL, the upgrader (push, rollback, a version that will not load), formation at the k-of-n threshold. On mainnet since 2026-10-18: real locks, mints, burns and multisigned releases, and three code upgrades pushed through the upgrader (app v2 to v4).

Not proven: adding a node, replacing one without downtime, recovering from a lost lease.
