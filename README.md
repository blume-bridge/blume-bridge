# Blume Bridge

A token bridge whose keys are held by a cluster of nodes instead of a person. Every node reads both chains on its own, the nodes vote on what they saw, and nothing is signed until k of n agree.

It has run on mainnet since 2026-10-18 between the XRP Ledger and XRPL EVM, with 29 tokens listed. This repo is the code it runs: the cluster, the EVM contracts and the design.

## Why

The hard part of any bridge is who holds the keys. A multisig of named people is a group chat with a treasury. A cluster that only signs what its own consensus says happened is a mechanism.

It started with a gap. Axelar is the main route off the XRP Ledger and only carries a curated list (XRP and USDC). A meme token with a few hundred holders had no way across. With this bridge an issuer pays a flat fee and the token can be bridged the same day.

## How it works

| Direction | The user signs | The cluster waits for | Then the cluster signs |
|---|---|---|---|
| XRP Ledger to EVM | A payment to the lock account, with the intent id in the memo | That payment to validate | k EIP-712 attestations; one node relays the mint |
| EVM to XRP Ledger | `burn(amount, rAddress)` on the ERC-20 | The burn to finalize | A multisigned payment out of the lock account |

- **XRP Ledger side:** one lock account holds a trust line to every listed token. Its SignerList is the n node keys with quorum k.
- **EVM side:** `TokenFactory` deploys one ERC-20 per listed token. `ThresholdMinter` mints only with k valid signatures from the node set.
- **The cluster** is a [HotPocket](https://github.com/EvernodeXRPL/hpcore) contract running on [Evernode](https://evernode.org). Ledger reads are not deterministic, so each node reads public RPC servers, broadcasts what it saw over HotPocket's node-to-node channel, and the contract acts only on k byte-identical views. Each node makes its own keys at first boot and only the public halves ever leave it.

If the nodes never agree, nothing moves and the user's tokens stay where they were. Fees are flat and paid in XRP (1 XRP in, 0.25 XRP out, 50 XRP to list). The bridged token is never taken as a fee, so the operators never hold a bag they have to sell.

More detail in [docs/DESIGN.md](docs/DESIGN.md).

## The trust model today

Read this before you bridge anything.

- **One operator runs every node.** The author is the tenant of all three Evernode instances and holds the upgrade key, so today the code can be changed by one person. The k-of-n machinery is real and runs on every transfer, but in practice this is a sole-operator bridge.
- **The lock account's master keys are still on.** There is no recovery signer yet, so the master keys are the way back if the cluster is lost. That is a second way for one person to move funds.
- **Evernode hosts can read the keys of the instance they run.** The rule is that no single host or provider holds k or more instances. Today that means 2 of 3, on three hosts run by three different companies.
- **There has been no third-party audit.** The code went through two internal security reviews. Treat it as beta.

Taking those three powers away from the author one by one is the plan in [docs/ROADMAP.md](docs/ROADMAP.md): outside operators, a recovery signer, keys that no host can read (a TEE or a threshold signer), then the master keys turned off.

## Beyond two chains

Nothing here is specific to XRPL EVM. A chain is a feed (how a node reads it) plus a signer (how the cluster spends from it). The same cluster could hold BTC on behalf of an XRP Ledger token ([docs/BTC_WRAPPER_DESIGN.md](docs/BTC_WRAPPER_DESIGN.md)), or bring Solana and Ethereum tokens to the XRP Ledger. None of that is built yet. See the roadmap.

## Layout

| Path | What |
|---|---|
| `cluster/` | The HotPocket contract (`src/`), operator scripts, the watchdog, the front-door relay, 900 tests. [cluster/README.md](cluster/README.md) |
| `contracts/` | `ThresholdMinter`, `TokenFactory`, `BridgeToken` (Solidity 0.8.24, Foundry), 173 tests including invariants |
| `docs/` | Design, roadmap, how code upgrades work, the ICP cosigner option, the Bitcoin design |

## Run the tests

```bash
git clone --recursive https://github.com/blume-bridge/blume-bridge
cd blume-bridge/cluster && npm ci && npm run typecheck && npm test
cd ../contracts && forge test
```

Running a dev cluster needs [hpdevkit](https://github.com/EvernodeXRPL/hp-devkit) and Docker on a Linux box; see `cluster/README.md`.

## License

MIT. Evernode and HotPocket have their own licenses; read Evernode's before you run hosts or instances.
