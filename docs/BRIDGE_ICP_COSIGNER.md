# The ICP co-signer: Evernode watches, a canister holds the other key

> **Status:** a design option. Nothing is built.
> **Why combine them:** replacing Evernode outright moves every read onto paid HTTPS outcalls and drops the operator model; combining them keeps Evernode for what it is good at (cheap, always-on watching by many operators) and adds what it cannot do (a key no host can read and no lapsed lease can lose).
> **Read with:** `DESIGN.md`, `ROADMAP.md`, `../cluster/KEYS.md`, `../contracts/src/bridge/ThresholdMinter.sol`.

## In one paragraph

The Evernode cluster keeps doing what it does today: it watches both ledgers, agrees over NPL and produces its k signatures. It stops being enough on its own. A canister on the Internet Computer holds a second key on the lock account's SignerList and on the minter, weighted so that **every transaction needs the canister plus k nodes**. The canister signs only after checking the claim itself against the source ledger. Two colluding hosts can no longer move the funds (today they can, Decision 3), a lapsed lease costs a watcher rather than a signer the bridge cannot replace, and the canister can pay the cluster's rent. Once the canister's upgrades and the cluster's loader are both taken out of one operator's hands, nobody, the operator included, can move the funds alone.

## What it fixes, in this doc set's own terms

| Today | With the co-signer |
|---|---|
| Any k hosts can read k node keys and sign (Decision 3: at 2 of 3, two hosts) | k host keys are half a signature. Theft also needs the canister, which no host runs |
| A lapsed lease erases a node's key; two lapses lose the accounts unless the master key is on (Decision 41) | The canister's key lives in ICP's threshold scheme, not in any instance. With the recovery path below, the canister and a recovery key can rotate in fresh nodes |
| Membership has no coordinator: a SignerListSet needs k of the very nodes that may be gone | The canister is always on and is part of every quorum, so it is the natural place for the join and replace rules |
| Lease renewals depend on a tenant seed on the operator's machine | The canister can hold a Xahau tenant wallet and extend leases from fees on a timer |
| A lost box loses the record of which burns were paid | The canister keeps its own durable record of every lock it approved and every burn it released |

## The two pieces

**The Evernode cluster (watchers).** Unchanged at its core: each node reads XRPL and XRPL EVM in fixed windows, the nodes vote over NPL (`vote.ts`), and `machine.ts` decides what should happen. Each node keeps its own XRPL and EVM keys (`bridge-keys.json`) and produces the same signatures it produces today. What changes is that those signatures are no longer enough to submit: a node sends them, with the source transaction's hash, to the canister and waits for the canister's signatures before it submits. The nodes' own signatures *are* the report; no new report format is needed.

**The canister (checker and second key).** A canister, ideally on ICP's 34-node fiduciary subnet (where ckBTC's minter runs) rather than a 13-node application subnet, because the canister's own logic decides what gets signed. It derives:
- one XRPL Ed25519 key (threshold Schnorr, `key_1`), whose address goes on the lock account's SignerList. A SignerList member does not need a funded account; it signs with the master key its address derives from;
- several EVM secp256k1 keys (threshold ECDSA, one derivation path each), whose addresses go on the minter (why several: "The minter" below);
- optionally a Xahau Ed25519 key for the tenant wallet.

No node, host or ICP replica ever holds any of these keys whole. Reconstructing one takes a third of the signing subnet's nodes.

## The flows

**Inbound: a lock on XRPL becomes a mint on XRPL EVM**
1. The user pays the lock account with the memo `blume:<intent id>:<0x…>`. The cluster already hands the site this memo (`machine.ts`), but today it ignores the address in it and mints to the intent's `to` (`machine.ts`). Intents live only in cluster state, so k hosts could change where someone else's lock mints. The co-signer makes the memo's address **binding**: it is in the user's own signed payment, so it is the one destination no host can rewrite. A lock without it, or with an address that disagrees with the intent, is not minted and goes back through `return:`.
2. Each node sees the payment in a validated ledger window. The nodes agree over NPL as today.
3. Each node signs the EIP-712 `Mint(tokenId, to, amount, srcTx)` as today and sends its signature to the canister with the lock's hash.
4. The canister:
   - checks it has k valid `Mint` signatures from distinct nodes in its node set. That proves k nodes said so, not that it is true;
   - fetches the lock by hash from two or three XRPL servers the nodes do not use, through HTTPS outcalls, and checks: `validated`, `tesSUCCESS`, `Destination` is the lock account, the amount from `meta.delivered_amount` (never `Amount`: partial payments), the memo's `0x…` equals `to`, the token is listed, and this hash has never minted;
   - re-derives `amount` from `delivered_amount` with the same conversion as `machine.ts` (18 decimals against the ledger's 15 significant digits; the dust rule) and refuses on any difference;
   - records the lock, adds its own `Mint` signatures, and returns them.
5. A node submits the mint with k node signatures plus the canister's. The minter's own checks still apply (one lock mints once, the daily cap).

**Outbound: a burn on XRPL EVM becomes a release on XRPL**
1. The user burns on the token; the burn names the XRPL destination.
2. The nodes agree, build the release `Payment` from the lock account, and each multisigns it as today. They send their signatures, the unsigned transaction and the burn's hash to the canister.
3. The canister checks the k node signatures over that exact transaction, fetches the burn receipt from XRPL EVM and checks the `Burn` event (from a token this minter listed, the amount, the destination), then checks the `Payment` field by field: `Account` is the lock account, `Destination` and amount match the burn after conversion, no `tfPartialPayment`, no `SendMax` or `Paths`, a bounded `Fee`, the memo names the burn, and this burn has never been released.
4. It records the burn, adds its multisign signature, and returns it. A node submits with `submit_multisigned`.

**The invariant the canister holds.** For every token: minted ≤ locked, and released ≤ burned, where it counts only what it verified itself. Since no mint or release can happen without its signature, the bridge cannot issue unbacked tokens or pay out against a burn that did not happen, whatever k hosts do.

**Everything else the nodes sign needs a rule too.** Today the nodes also sign trust lines on the lock account for new listings, returns and refunds, payouts from the funding account, and on the minter listings, updates, fee changes, sweeps, resume and rotations. Recommendation: the first cut puts the canister on the **lock account and the minter only**, since that is where user funds sit, and gives it a narrow rule per transaction type (a `TrustSet` only for a listed token at its recorded `trustLimit`, a return only to the lock's own sender, a sweep only to the configured addresses, and so on). The funding account holds revenue, not deposits, and can stay node-only.

## How the canister trusts the nodes

It doesn't, really. The node signatures do two jobs: they keep the canister from spending cycles on claims nobody backs, and they are the nodes' half of the on-chain quorum. The canister's own check against the source ledger is what makes its signature mean something. The security comes from the ledger requiring both halves, not from either side believing the other.

What the canister needs to know about the nodes is only their public keys: the XRPL addresses on the SignerList and the EVM signer addresses on the minter. It keeps that set itself and changes it only through the rotation rule (below), never because the nodes say so.

## The keys and the weights

**The lock account (XRPL has native weights).** For n nodes and a node quorum k: the canister's weight is n + k, each node's is 1, the recovery key's is k, and the quorum is n + 2k.

| Who signs | 2 of 3 (canister 5, nodes 1, recovery 2, quorum 7) | 3 of 5 (canister 8, nodes 1, recovery 3, quorum 11) |
|---|---|---|
| Canister + k nodes | 7: **yes** (the normal path) | 11: **yes** |
| Canister + k−1 nodes | 6: no | 10: no |
| All n nodes | 3: no | 5: no |
| All n nodes + recovery | 5: no | 8: no |
| Canister + recovery | 7: **yes** (recovery, gated by the canister's code) | 11: **yes** |
| Canister alone | 5: no | 8: no |

Every path that reaches quorum includes the canister, so the canister's code decides what any quorum can do. The recovery path exists because node keys still die with their instances: the canister co-signs with the recovery key **only** a `SignerListSet`, **only** once fewer than k nodes have reported for a set number of days, and **only** after it has published the new list and waited (say 7 days). XRPL cannot enforce a delay on a multisigned transaction; the canister enforces it by refusing to sign earlier. Master keys on both accounts go off (Decision 41's condition, a recovery path, is then met).

**The minter (equal weights only, and it cannot be replaced).** `ThresholdMinter` takes k-of-n signatures from equal-weight signers, has no owner and no upgrade path, and every `BridgeToken` names it as an `immutable minter`. A new minter with a "required signer" would orphan every listed token, so the existing minter has to express "canister + k nodes" in equal weights. It can: the canister puts several of its own addresses on the signer set. With n + 1 canister addresses, k recovery addresses and a threshold of n + 1 + k:

| Who signs | 2 of 3 (canister 4 addresses, recovery 2, threshold 6, 9 signers) |
|---|---|
| Canister + k nodes | 4 + 2 = 6: **yes** (one mint = 4 threshold ECDSA signatures) |
| Canister + k−1 nodes | 5: no |
| All nodes + recovery | 3 + 2 = 5: no |
| Canister + recovery | 6: **yes** (rotation only, gated as above; the minter adds its own `rotationDelay`) |

The set moves into place through the minter's existing `proposeRotation` (k node signatures today), then `executeRotation` after the delay. At 3 of 5 it is 6 + 5 + 3 = 14 signers, inside the minter's limit of 32. Without the recovery addresses the canister needs only n − k + 1 addresses (fewer signatures per mint), but losing more than n − k nodes would then freeze the signer set for good: exits keep working, mints of the listed tokens stop forever. Recommendation: keep the recovery addresses.

**One sub-choice, open.** With the weights above, if ICP itself stopped for good, the funds would stay locked: no quorum exists without the canister. Raising the recovery weight so that all n nodes plus the recovery key reach quorum would add an escape hatch, at the price that the operator plus every host could then bypass the canister. Recommendation: leave the hatch out. ICP's subnet stalls so far have been temporary, and the hatch reopens the path the design exists to close.

## Who could still steal, and how to make it nobody

**As described, the operator could.** The operator would hold both halves: the canister's controller can install code that signs anything, and the cluster's upgrade key (Decision 36) can install code that makes the nodes sign anything. Two locks, one person holding both keys. To make it so nobody can, in this order:

1. **The canister's upgrades.** Hand control of the canister to a small upgrader canister that publishes the new module's hash and installs it only after a waiting period (7 days), from a reproducible build anyone can check against the published source. ICP shows any canister's module hash and controllers to anyone, so the check is public. The stronger alternative, no controller at all ("blackholed"), also makes every bug permanent.
2. **The cluster's upgrades.** The same for the loader: a loader v2 that needs a quorum of operators to approve, or the same waiting period.
3. **The ledger.** Master keys off on the lock account, and no recovery key that reaches quorum without the canister (the table above already holds this).
4. **The minter.** Nothing to do: no owner, rotation needs k signatures and waits `rotationDelay`. It is the model the canister copies.
5. **The admin key.** Cut to pause only.

With waiting periods in place, "nobody can steal" becomes "nobody can steal without a week of public warning, during which users withdraw and nodes can refuse to sign the new code's requests." That is the standard serious bridges hold themselves to. Until steps 1 and 2 are done, users are trusting the operator to run it honestly, and the site has to say so.

**What stays trusted after all five:** ICP itself (a third of the signing subnet, or NNS governance changing the protocol) **together with** k colluding Evernode hosts; and the servers both sides read from (next section).

## What it does not fix

- **Reads still trust RPC servers.** The canister should read XRPL from servers the nodes do not use, so one lying server cannot fool both halves. On XRPL EVM there is only one public server, `rpc.xrplevm.org`, so on the outbound path both halves read the same source: a common-mode failure until there is a second one (an `exrpd` mainnet node of the operator's own is the obvious candidate).
- **ICP adds a liveness dependency.** If the fiduciary subnet stalls, the bridge pauses. Nothing is lost; it waits.
- **The decentralization story changes shape.** It becomes "independent operators *and* ICP must both agree," not operators alone. The 70/30 operator split is untouched.
- **More moving parts.** Two codebases (HotPocket contract and canister) must agree on amount conversion and transaction shapes, byte for byte. Golden tests shared between them are mandatory.

## Cost, roughly (not measured)

- **Signatures:** about 26 billion cycles per `key_1` signature, roughly $0.035 at about $1.35 per trillion cycles.
- **Reads:** one HTTPS outcall per server per transfer. On a 34-node subnet the published formula, base (3,000,000 + 60,000·n)·n plus (400 per request byte + 800 per `max_response_bytes`)·n cycles, comes to well under a billion cycles for a 20 kB response cap: a tenth of a cent.
- **Per transfer:** inbound about 4 signatures and 2 to 3 reads, about $0.14; outbound 1 signature and 1 to 2 reads, about $0.04. That stays below the fees charged (1 XRP in, 0.25 XRP out) while XRP is above about $0.20.
- **No polling bill.** The canister never watches anything; it only checks what the nodes bring it. That is the whole reason to keep Evernode in the design: watching around the clock costs nearly nothing there and real money on ICP.

## Unknowns to prove first (a one-day spike, testnet and Devnet only)

1. A canister-derived Ed25519 key signs an XRPL **multisign** blob that rippled accepts as one SignerList member (Devnet, alongside two `xrpl.js` signers).
2. A canister reads a validated XRPL transaction through HTTPS outcalls from two servers, with a transform that makes every replica's response byte-identical.
3. A canister-derived ECDSA key produces an EIP-712 `Mint` signature the Devnet minter accepts, with the canister's several addresses sorted among the node signers.
4. What happens to a canister that runs out of cycles (frozen, then uninstalled with its ID kept) and that a reinstall on the same ID derives the same addresses. Expected from how the keys are derived; to be seen, not assumed.
5. Whether an Evernode lease extension from a canister-held Xahau account works, and whether existing leases can move to it or must be re-leased.

## Order of work, each step useful alone

1. **The spike** (above). Throwaway code, faucet money.
2. **Co-signer on the Devnet cluster.** The canister on the lock account's SignerList and the minter's signer set with the weights above, the nodes sending their signatures to it before submitting, mints and releases only. Prove a round trip, then prove that two nodes alone cannot move anything.
3. **The tenant wallet.** The canister extends the cluster's leases from fees.
4. **Membership through the canister.** Join and replace (`ROADMAP.md`, step 1) with the canister as the always-on coordinator, and the recovery path tested by letting two Devnet nodes lapse.
5. **The handover.** The waiting-period upgrader for the canister, loader v2 for the cluster, master keys off, the admin key cut to pause only. Only then does the site's copy change.

Mainnet comes after step 2 has run on Devnet for a while, with the same low caps as today.
