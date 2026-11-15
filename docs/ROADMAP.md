# Roadmap

Today one person can do three things the design says nobody should: change the code (the upgrade key), move the locked funds (the master keys), and decide where every node runs (the leases). This is the order in which those go away, and then where the cluster could go next. Nothing below is built unless it says so.

## 1. Operators who are not the author

Already true: n and k come from config, and nothing assumes three nodes. What is missing is membership. Today the node set is fixed at first boot.

- **Joining.** A new operator sends a join request signed with their node's key. At first an admin key admits them; later the current operators' quorum does.
- **Rotating.** On admission the cluster patches its own peer list and consensus threshold, multisigns a new SignerList on both XRP Ledger accounts, and rotates the minter's signer set (propose, a three-day wait, execute). Mints are signed by the old set until the rotation executes.
- **Handover is replacement, never transfer.** An operator never receives someone else's instance. They lease a fresh one on their own Evernode tenant wallet, on a host they choose, it makes its own keys, and one rotation swaps it in and the old node out.
- **Paying operators.** A payout address per operator, from the 70% share.
- **The ceiling.** An XRP Ledger SignerList holds at most 32 signers.

## 2. Choosing operators so they cannot collude

k-of-n only means something if k of the n cannot be the same party.

- **Public selection.** The operator set is published, and admission is a public decision with a written rule.
- **Spread.** The rule that no single Evernode host may hold k instances (Decision 3) extends to people, hosting providers and jurisdictions.
- **Bonds.** Each operator posts a bond in XRP into an account under the same SignerList. Theft is provable on chain, so a bond can be slashed (a Xahau hook is one way). The value the bridge accepts is capped by the bonds behind it.

## 3. Keys no host can read

Spreading instances limits what a curious host can do. Only taking the keys out of the host's reach fixes it. Two routes, which also work together:

- **A trusted execution environment.** The signing key lives in an enclave (Intel TDX or SGX, AMD SEV) with remote attestation. The cluster still decides what happened; the enclave signs only what the cluster's consensus hands it, and nobody can read the key out, the machine's owner included. NEAR's TEE-based agents are one ready-made route. Evernode instances are rootless containers with no device access, so the enclave would run next to the cluster, not inside an instance.
- **A threshold-signing cosigner.** An Internet Computer canister holds a key through threshold ECDSA or Schnorr, so no single machine in its subnet ever holds the key. It sits on the SignerList and the minter as one more required signer, and reads the ledgers itself before it signs. Hosts could then read every node key and still not move funds. Written up as a design option in [BRIDGE_ICP_COSIGNER.md](BRIDGE_ICP_COSIGNER.md). NEAR's Chain Signatures (a multi-party signing network) is a similar route.

Either way the upgrade key has to be split too: code changes approved by a quorum of operators, or a public waiting period anyone can watch and exit during.

## 4. Closing the escape hatches

- A recovery signer on both SignerLists, then the master keys turned off (Decision 41).
- Leases renewed from fees on a timer, with an alert at 60 and 30 days.
- Consensus state copied off the instances, so a lost lease is recoverable.
- Replacing a node with no downtime, proven on a throwaway cluster first.

## 5. More chains

A chain is a feed (how a node reads it) plus a signer (how the cluster spends from it). The cluster does not care which chains they are.

- **Xahau.** The same key types and multisig as the XRP Ledger. The closest next step.
- **Bitcoin to the XRP Ledger.** The cluster as the k-of-n custodian of a Bitcoin vault, issuing 1:1 IOUs on the XRP Ledger. Full design, trust model and fees in [BTC_WRAPPER_DESIGN.md](BTC_WRAPPER_DESIGN.md).
- **Ethereum, Base and Solana tokens to the XRP Ledger.** Today's bridge in reverse: lock on the source chain in a contract (or a Solana program) that checks k signatures, and issue the token on the XRP Ledger from an issuer account controlled by the cluster's SignerList. This is how a Solana or Ethereum meme token could trade on the XRP Ledger's DEX and AMM.
- **Monero.** Possible in principle with Monero's own multisig, which is interactive and awkward, and there is no contract on that side to check anything. The hardest on this list.
