# cluster

The operator side of Blume Bridge: a HotPocket contract that runs as a k-of-n cluster on Evernode, watches the XRP Ledger and XRPL EVM, and signs for both. How it works and why: [`../docs/DESIGN.md`](../docs/DESIGN.md). Where keys live: [`KEYS.md`](KEYS.md). Monitoring: [`WATCHDOG.md`](WATCHDOG.md).

The bundle is two files. `dist/index.js` is a small fixed loader and `dist/app.js` is the contract it runs, which can be replaced on a live cluster ([`../docs/BRIDGE_UPGRADES.md`](../docs/BRIDGE_UPGRADES.md)).

## Layout

```
src/contract.ts      HotPocket entry: reads in read-only mode; inputs, feed, NPL vote, apply, save in consensus mode
src/machine.ts       The state machine (locks, fees, returns, listings, deadlines). Pure, no I/O, unit-tested
src/vote.ts          The NPL view vote: broadcast this node's ledger view, tally k-of-n identical views
src/feed/xrpl.ts     XRP Ledger over public JSON-RPC: fixed windows of validated ledgers
src/feed/evm.ts      XRPL EVM over public JSON-RPC: burns and minter events in fixed block windows
src/feed/fake.ts     A pretend ledger read from a file on each node, for dev cluster tests
src/signing.ts       XRP Ledger multisigning (including Batch); src/attest.ts and src/evm.ts for EIP-712 mints
src/loader*.ts       The fixed loader; src/upgrade.ts holds its rules
src/api.ts           The read shapes the website uses
genesis/dev.json     Fake feed, seeded tokens, k=2 n=3
genesis/devnet.json  XRPL Devnet accounts (scripts/testnet-setup.ts writes it; do not hand-edit)
genesis/testnet.json XRPL Testnet accounts, same script with XRPL_NETWORK=testnet
clients/stage1.ts    End-to-end test against a running dev cluster
clients/query.ts     One read (or --input) against one node
scripts/             Deploy, genesis, Evernode leasing, operator commands (admin.ts), upgrades (upgrade.ts),
                     key backup, state snapshots, the preflight launch gate, the watchdog, the front-door relay
hp/                  hp.cfg overrides for the bundle and the Evernode instance config
```

## Networks

`XRPL_NETWORK` (`devnet`, `testnet` or `mainnet`) picks the XRP Ledger network for every script, and is deliberately the only endpoint input (`scripts/network.ts`). Each network keeps its own `keys/<network>.json` (gitignored) and `genesis/<network>.json`. The EVM side is XRPL EVM testnet (chain 1449000) or mainnet (1440000).

Each cluster needs **its own `ThresholdMinter`**, passed as `BRIDGE_MINTER` when the genesis is generated. The XRP token id is `keccak('XRP:native')` on every XRP Ledger network, so two clusters sharing a minter would share the XRP listing and its daily cap, and XRP minted from a Testnet lock could be redeemed against the Devnet lock account.

## Dev loop

A dev cluster is three [hpdevkit](https://github.com/EvernodeXRPL/hp-devkit) nodes in Docker on a Linux box (`DEPLOY_HOST`, an ssh host).

```bash
npm ci
npm test && npm run typecheck
GENESIS=dev bash scripts/deploy-dev.sh                                       # fake feed
XRPL_NETWORK=devnet BRIDGE_MINTER=0x... npx tsx scripts/testnet-setup.ts     # once: faucet accounts, genesis/devnet.json
BRIDGE_MINTER=0x... GENESIS=devnet bash scripts/deploy-dev.sh                # real XRPL Devnet feed, fresh state
GENESIS=snapshot bash scripts/deploy-dev.sh                                  # new code, state carried over
npx tsx scripts/testnet-actions.ts lock 250 0x<evm-address>                  # a test user asks for an intent, pays the fee, then the lock
npx tsx scripts/xrpl-feed-check.ts                                           # that payment, as a node's feed sees it
```

Every round with activity logs one JSON line on each node (`/tmp/bridge-cluster.log`): what the node heard over NPL, the vote counts, what was applied and written, and how long it took. On Evernode, where there is no shell, the `log` read returns the tail.

Leasing a cluster on Evernode: `scripts/evernode-cluster.sh` (one instance per host, and it refuses a placement where one host could reach k), then `scripts/cluster-health.ts`. Renewing: `scripts/evernode-extend.sh`. Before a mainnet launch: `scripts/preflight.ts`.

## Messages

**Reads** (read-only, any node): `status`, `operators`, `tokens`, `token {sym}`, `transfer {id}`, `transfers {from|to|xrpl|evm}`, `actions`, `action {id}`, `evmActions`, `evmAction {id}`, `payouts`, `balances {xrpl}`, `trustlines {xrpl}`, `account {xrpl}` (what a release to that account would meet), `unmatched`, `code` (the running version), `log {lines}`, `ping`.

- `operators`: `{ k, n, ready, lockAccount, fundingAccount, feeXrp, returnFeeXrp, metaFeeXrp, issuerListingFeeXrp, minter, evmChainId, signers }`. Fees are decimal strings in XRP. `minter` and `evmChainId` are null until the cluster has an EVM side; `minter` is where a burn is sent.
- `transfer` / `transfers`: `{ id, dir, sym, amount, receive, step, from, to, srcTx, dstTx, done, failed, held, memo, feeXrp, feeTx, awaitingFee, … }`. `awaitingFee` is there only while a lock is in without its fee, and says where to pay it and what it costs to take the lock back instead. `failed` is one of `expired`, `cap`, `returned`, `dust`, or an EVM action that never confirmed. A burn to something that is not an address is held as `bad-destination` and minted back at once.
- `token` / `tokens`: includes `dustUnits`, surplus backing in the lock account that burns could not carry (18 decimals against the ledger's 15 significant digits). It is never revenue and never sold; the lock account holds `lockedUnits + dustUnits`.
- `payouts`: the next payout as the scheduler will work it out. Its first payment tops the lock account up to `payout.lockFloorXrp` above its reserve, and the rest is split 70/30.

**Inputs** (consensus): `intent.transfer {dir, sym, amount, from, to}` opens a transfer and returns the `memo` the lock must carry (`blume:<id>:<0x…>`), `payTo` (the lock account) and, inbound, `feeTo`, `feeMemo` (`blume:fee:<id>`) and `feeDrops`, the fee fixed at the quote. One HotPocket user key holds at most `params.maxOpenIntents` (8) open intents.

**Ledger memos** the cluster acts on:

- On a payment to the lock account: `blume:<intent id>[:<0x…>]`. A lock mints only when its intent's fee is attached, and then mints the full amount. A bare `0x…` memo, an unknown id or a closed intent mints nothing; the payment is recorded as unmatched.
- On an XRP payment to the funding account:
  - `blume:fee:<intent id>`: the fee, from the account the intent named. It can come before the lock, with it in one Batch, or after it.
  - `return:<lock tx hash>`: at least `returnFeeXrp`, from the lock's own sender, for a lock that is waiting for its fee or matched no intent. The lock goes back in full.
  - `propose:{"c":currency,"i":issuer,"n":name,"img":logo}`: `issuerListingFeeXrp`, from the issuer, or from anyone when the issuer is locked for good.
  - `meta:{"c":currency,"n":name,"img":logo}`: `metaFeeXrp`, from the issuer, to change a listed token's name or logo.

A fee, return, proposal or name change the cluster refuses goes back to whoever paid it, less the network fee (a refused proposal or name change keeps 1 XRP). XRP sent to the funding account with a memo the cluster does not read stays there, recorded, for an operator to decide.
