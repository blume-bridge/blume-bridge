# Bridge cluster upgrades

> **Status:** built and running on mainnet. Deliberately lean: any one upgrader key can push new code, with no delay. Design context: `DESIGN.md`, Decision 36.

## The problem

The mainnet cluster is three HotPocket instances rented on Evernode hosts run by other people. Nobody has a shell on them. The only way code gets there is the **first bundle** that `evdevkit cluster-create` uploads. After that:

- The bundle's `hp.cfg.override` sets `bin_path` to our contract, and `evdevkit deploy` (a second upload) works by talking to the *bootstrap* contract, which our contract has replaced. So a running instance takes no second bundle. **Confirmed on real instances:** a second `evdevkit deploy` is refused ("Bootstrap contact is not available"; the instance answers with the app's own error).
- Whatever is in the first bundle, including `genesis.json`, is what the cluster runs until its instances are destroyed. The genesis is read once.

Replacing the cluster instead is worse than it sounds: the cluster has no way to change its own signer lists (no `SignerListSet` action, no minter rotation proposal in `cluster/src`), so with the master keys disabled new node keys could never take over the lock account.


## Options weighed

| | What it is | For | Against |
|---|---|---|---|
| **A. No upgrader: replace the cluster** | New instances, new node keys, new minter, state carried by a snapshot genesis | No code-update authority exists | Strands the lock account once the master key is disabled (above). Days of downtime. An urgent fix is impossible |
| **B. Evernode's own upload** (`evdevkit deploy`) | Re-upload a bundle to the instance | Nothing to build | Probably refused once our contract is running. Runs an arbitrary `install.sh` as root in the container |
| **C. HotPocket's template upgrader** (`upgrader-contract` in the hpdevkit image) | A zip arrives as an input and is unzipped over the contract | The documented pattern | Checks nobody's identity, shells out to `unzip`, `jq` and a generated `post_exec.sh`, and the upgrade logic lives in the code being replaced, so one bad upload bricks the cluster |
| **D. A fixed loader and a replaceable app (built)** | `index.js` is a ~230-line loader that never changes; the real contract is `app.js`; an upgrade replaces `app.js` | The loader accepts the next upgrade even when the app is broken; no shell, no zip; the rules are small and tested | One more file; the loader itself cannot be upgraded (that would be a full migration) |

## What is built

### Files, in the consensus state directory

`index.js` (the loader, `src/loader.ts` and `src/loader-core.ts`), `app.js` (`src/contract.ts`, which exports `contract` and does not start HotPocket itself), `app.prev.js` (the version before), `upgrade.json` (the loader's own state: version, hash, upgrader keys, short history, the outcome of the last message), `genesis.json`. `npm run build` makes `dist/` with `index.js` and `app.js` from two ncc builds; `UPGRADE_KEYS=ed…,ed…` puts the keys into the bundled genesis (`scripts/bundle-genesis.ts`), and a mainnet genesis with no key is refused unless `IMMUTABLE=1`.

### The rules (`src/upgrade.ts`, pure and tested)

An **upgrader** is a HotPocket user key listed in `upgrade.json` (from the genesis' `upgrade.upgraders`). **Any one** of them is enough. A message is `{type:"upgrade", op, version}` and `version` must be the current version plus one, so an old message can never be played again.

- `code {hash, gz}`: `gz` is the new `app.js` gzipped and base64'd (at most 3 MiB compressed, 16 MiB unpacked). The loader checks the SHA-256 and that it compiles, installs it, and keeps the old file as `app.prev.js`.
- `rollback`: swaps `app.js` and `app.prev.js`.
- `keys {upgraders}`: replaces the key list (at most 5; refuses to remove the last key).

Only an upgrader's input is ever read, so a stranger's cannot make the loader parse or decompress anything; their messages go to the app like any other. An upgrader's message is taken out of the input list, and the app never sees it. The new code handles the very round that installed it.

### Failure handling

- **A version that will not load** (throws, or exports no `contract`): every node falls back to `app.prev.js` the same way, says why in the log and in the `code` read, and still accepts the next upgrade.
- **A version that loads and misbehaves:** `rollback`, or push a fix.
- **A swap cut off halfway:** `upgrade.json` is written last; at the start of each round the recorded hash is the truth and the file that carries it is the app.
- **A damaged `upgrade.json`:** upgrades are off, the app still runs.

### Observing and operating

- `{type:"code"}` read (answered by the loader, without loading the app): version, hash, the hash of the file on disk, the previous hash, upgrader keys, history, which file is loaded and why not the other, and the outcome of the last message.
- `npx tsx scripts/upgrade.ts hash | status --node a,b,c | push | rollback | keys` (see the header of the file). `status` says whether all nodes agree. A key is made with `scripts/admin.ts keygen --key keys/upgrade.json`.

## Lessons from running it

1. **HotPocket awaits only an `async function`.** The library checks `callback.constructor.name === 'AsyncFunction'`; a plain arrow that returns a promise ends the round, and kills the process, the moment it returns. The first deploy ran no app at all until the entry was an `async function` (a test pins this).
2. **Do not answer an upgrade with an output.** Contract outputs are compared across nodes ("Consensus output hash didn't match our output hash"). The first version replied to the upgrader; on a cluster where one node lags and resyncs routinely, a reply in the wrong round made the nodes disagree and stalled the cluster for good (a redeploy was the cure). Now the loader sends nothing in a consensus round; the outcome is written into `upgrade.json` (`last`, under the request id) and the CLI reads it back with a `code` read.
3. `hpfs` accepts `rename`, so the swap is a plain rename.
4. A code read is not consensus, so it is answered directly.

## Trust, honestly

Whoever holds an upgrader key can replace the code and so move every locked token. Today that is the one operator who already runs every node, so no trust is added. Keep the key off the machines the nodes run on (an OS keychain plus an offline copy), separate from the operator key. If it may have leaked, `keys` replaces it. Host operators cannot forge an upgrade (they would need the key); they can already read their instance's node key, which is why no single operator may hold k instances.

## Left out on purpose, and how to add it

A delay, a veto, k-of-m approvals and an expiry were designed and cut to keep the loader small. They need the loader to hold the policy, and the loader cannot be upgraded. If a second person or a second operator arrives, the way in is an app upgrade that rewrites `index.js` (an app can write the state directory), rehearsed first on the Evernode hosts; a bad loader would brick the upgrade path, so that change would be tested like a migration.

Config changes (an RPC server, a payout address) ride an app upgrade whose first run applies a migration keyed by a schema version in the state.

## Tests and rollout

- `test/upgrade.test.ts`: every rule, pure. `test/loader.test.ts`: the loader against a fake HotPocket context and a real directory (an upgrade, a refusal, a stranger, a broken version, a rollback, a key change, a cut-off swap, a damaged state file, the read, the async entry).
- Dev cluster (three hpdevkit nodes): upgrade, a version that throws on load (all three fall back and keep working), a stranger's key (ignored), rollback, key add and remove, all with the three nodes agreeing on version, hash and state hash.
- Three real Evernode instances on separate hosts: the first bundle reached every instance and each ran the loader and app; an upgrade, a rollback, a version that will not load (all three fell back and kept serving), a key added and removed, each checked on all three; node keys unchanged throughout; a second `evdevkit deploy` refused. Not testable without a shell: an instance restart.
