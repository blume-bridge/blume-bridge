# The watchdog

`scripts/watchdog.ts` watches the bridge from outside. It runs on any machine that is not a node box, needs no key, no ssh and no access to a node's disk, and tells a Discord channel (or stdout) when something needs a human. Rules in `scripts/watchdog-rules.ts`, tested with made-up snapshots.

It reads only what is already public: the front door's WebSockets (the ones the site uses) and the two chains' public RPCs.

## Running it

```bash
cd cluster && npm ci                     # once, on the watchdog machine
cp /dev/null /etc/blume-watchdog.env && chmod 600 /etc/blume-watchdog.env   # then fill it in (below)
set -a && . /etc/blume-watchdog.env && set +a
./node_modules/.bin/tsx scripts/watchdog.ts --print-config      # what it will do; never prints the webhook
./node_modules/.bin/tsx scripts/watchdog.ts --test-alert         # one message to the webhook (stdout if unset)
./node_modules/.bin/tsx scripts/watchdog.ts --once --dry-run     # read everything, print what it would send, keep no state
./node_modules/.bin/tsx scripts/watchdog.ts --once               # one real pass (cron)
./node_modules/.bin/tsx scripts/watchdog.ts                      # a pass every WATCHDOG_INTERVAL_SECONDS (systemd)
```

`--dry-run` is the first thing to run against a new front door; check it by eye (`nodes 5/5`, a sensible `lcl`, `xrpl lag` in single digits).

### Settings (environment)

| Variable | Default | Meaning |
|---|---|---|
| `WATCHDOG_NODES` | required | The front door endpoints in node order, `wss://host:port` or `host:port`, comma separated. Any number: five nodes, five entries |
| `WATCHDOG_WEBHOOK` | stdout | Discord webhook URL (https). Treated as a secret: never printed, scrubbed from errors |
| `WATCHDOG_HEARTBEAT_URL` | none | An https URL pinged after each pass that delivered everything (healthchecks.io style): the alarm for the watchdog itself dying |
| `XRPL_NETWORK` | `devnet` | `mainnet` for production. Picks the public XRPL RPCs and the reserve rules. A wrong value shows up as "lock account ... does not exist on ..." |
| `WATCHDOG_XRPL_RPC`, `WATCHDOG_EVM_RPC` | by network / chain id | Comma separated JSON-RPC URLs, tried in order. The EVM default comes from the chain id the cluster reports (1440000 and 1449000 are known) |
| `WATCHDOG_STATE` | `./watchdog-state.json` | The state file, mode 0600 |
| `WATCHDOG_INTERVAL_SECONDS` | 60 | Between passes in the long-running mode (minimum 10) |
| `WATCHDOG_NODE_TIMEOUT_SECONDS`, `WATCHDOG_RPC_TIMEOUT_SECONDS` | 15, 10 | How long a node and a public RPC get to answer |
| `WATCHDOG_COOLDOWN_MINUTES` | 60 | Between reminders for a condition that stays true |
| `WATCHDOG_COOLDOWNS` | none | Per condition, e.g. `lcl-stalled=15,transfers-held=240` (the names in the table) |
| `WATCHDOG_IGNORE_FAILED` | `expired` | Transfer failure reasons not worth an alert |

The thresholds are in the table below. A setting that does not parse stops the watchdog with its name: a typo must not quietly switch a rule off.

## What it checks

| Condition (cooldown name) | Fires when | Setting | Severity |
|---|---|---|---|
| `front-door-down` | No node answers for `WATCHDOG_UNREACHABLE_POLLS` passes (nginx, the relay or this machine's route) | `WATCHDOG_UNREACHABLE_POLLS` 2 | critical |
| `node-unreachable:N` | Node N does not answer for that many passes in a row (the message carries the error: a lapsed certificate reads as one) | same | warn |
| `lcl-stalled:N` | Node N's last closed ledger has not advanced for the window | `WATCHDOG_LCL_STALL_SECONDS` 120 | warn |
| `cluster-halting` | Fewer than ceil(0.8 n) nodes are closing ledgers: HotPocket consensus needs 80% (4 of 5, 3 of 3, 6 of 7) | n from the cluster | critical |
| `state-hash` | Reachable nodes report different `stateHash` for `WATCHDOG_HASH_POLLS` passes; says which nodes hold which | 2 | critical |
| `cursor-lag:xrpl`, `cursor-lag:evm` | The cluster's XRPL cursor or EVM cursor is more than the window behind the chain's head (critical at 3 windows); says how long the cursor has been still. This also catches a run of null views | `WATCHDOG_XRPL_LAG_LEDGERS` 100, `WATCHDOG_EVM_LAG_BLOCKS` 200 | warn / critical |
| `views-contested` | A node's last round had two different views each reach k, for `WATCHDOG_CONTESTED_POLLS` passes | 2 | critical |
| `views-null` | A node proposes a view and none reaches k, for `WATCHDOG_NULL_POLLS` passes | 3 | warn |
| `actions-pending` | An XRPL action is `queued` or `pending` for over the window (critical at 4 windows) | `WATCHDOG_ACTION_MINUTES` 30 | warn / critical |
| `evm-actions-stuck` | An EVM action is pending with at least 3n relayer attempts: every operator has relayed it three times | 3n | critical |
| `evm-actions-pending` | An EVM action is pending for over the window with attempts left | `WATCHDOG_ACTION_MINUTES` | warn |
| `transfers-held` | Any transfer is held: a release the ledger refused; lists result, attempts and when the tokens are minted back | none | warn |
| `transfers-awaiting-fee` | A lock has waited for its fee longer than the grace: tokens locked, nothing minted, nothing expiring: a user to reach | `WATCHDOG_AWAITING_FEE_MINUTES` 5 | warn |
| `transfers-failed` (event) | A transfer ended in a failure state other than the ignored ones; `mint not confirmed` and `return not confirmed` are critical | `WATCHDOG_IGNORE_FAILED` | warn / critical |
| `action-failed`, `evm-action-failed` (events) | An action failed or expired for good | none | critical / warn |
| `unmatched-new` (event) | New entries in `unmatched`. A top-up of the lock or funding account shows up here too: expected | none | warn |
| `token-new` (event) | A token appeared. The message carries its state; whether it **opens by itself** (no limit once its ERC-20 lands) or **waits for an operator**, with the `admin.ts` command to shut or to open it, ready to paste (the mainnet key file when the cluster is on chain 1440000); and a **suggested cap**, should it need one: the cap in tokens that `WATCHDOG_SUGGEST_CAP_XRP` XRP buys at its XRP pool's price, rounded down to three digits. Off-consensus, read-only, a number to set by hand, and withheld for a pool under `WATCHDOG_MIN_POOL_XRP` | 1000, 1000 | info |
| `xrp-low:lock`, `xrp-low:funding` | The account's balance less its reserve (base plus owner reserve for every object) is under the warn margin (critical under the second) | `WATCHDOG_FREE_XRP_WARN` 10, `WATCHDOG_FREE_XRP_CRIT` 3 | warn / critical |
| `relayer-low:0x...`, `relayers-exhausted` | An operator's EVM address holds under the minimum; critical when every one does | `WATCHDOG_RELAYER_MIN_XRP` 1 | warn / critical |
| `supply-short:SYM` | Once a day (and on every pass while one is active): the lock account's holding of a token is below the ERC-20's total supply by more than the tolerance. The supply is read first, and a shortfall is read again 15 seconds later before it is believed | `WATCHDOG_SUPPLY_EVERY_HOURS` 24, `WATCHDOG_SUPPLY_TOLERANCE` 0.000000001 | critical |
| `rpc-down:xrpl`, `rpc-down:evm` | The watchdog's own RPCs fail to give a head for several passes: the lag checks are blind | `WATCHDOG_RPC_DOWN_POLLS` 3 | warn |
| `reads-failing`, `watchdog-blind` | A cluster read keeps failing, or part of what the watchdog watches cannot be read (wrong network, RPC down) | 3 passes | warn |

The cooldown name of a condition is the part before any colon (`xrp-low`, `cursor-lag`, `relayer-low`). A condition that cannot be judged on a pass (a read failed, a node is silent) neither fires nor clears: nothing is called recovered on a pass that could not look.

### How alerts behave

- **Once, then reminders.** A condition alerts when it starts, repeats as `STILL FIRING` after its cooldown, and sends `RECOVERED` (with how long it lasted) when it clears.
- **Changes are sent at once.** A second held transfer, a worse severity or another differing state hash is an `UPDATED` message that ignores the cooldown.
- **Events happen once.** New tokens, unmatched payments and failures are announced once each and remembered, in a bounded list.
- **A message that did not go out is raised again.** If the webhook fails (a 429 is waited out once if short), nothing is remembered as sent, and the heartbeat is withheld.
- **Nothing on-chain can ping anyone.** Names and memos are cut to one short line, markup characters are removed and `@` is neutralised, and every post is sent with mentions disallowed.
- **Messages carry no secrets.** Addresses, hashes, symbols, counts and node labels (host:port of the public front door). The watchdog holds no key.

## Where to run it

Off the node boxes, on a machine that does not share their failure: a small VPS at another provider, or an always-on machine at home. Not on a node host: the point is that it still talks when the box does not. Give it its own user and a state directory.

### systemd (long-running)

```ini
# /etc/systemd/system/blume-watchdog.service
[Unit]
Description=Blume bridge watchdog
After=network-online.target
Wants=network-online.target

[Service]
User=bridgewatch
WorkingDirectory=/opt/blume-bridge/cluster
EnvironmentFile=/etc/blume-watchdog.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=WATCHDOG_STATE=/var/lib/blume-watchdog/state.json
ExecStart=/opt/blume-bridge/cluster/node_modules/.bin/tsx scripts/watchdog.ts
Restart=always
RestartSec=20
StateDirectory=blume-watchdog
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
install -m 600 -o root /dev/null /etc/blume-watchdog.env      # WATCHDOG_NODES=..., WATCHDOG_WEBHOOK=..., XRPL_NETWORK=mainnet
systemctl enable --now blume-watchdog && journalctl -u blume-watchdog -f
```

### cron (one pass a minute)

```cron
* * * * * cd /opt/blume-bridge/cluster && flock -n /tmp/blume-watchdog.lock sh -c 'set -a; . /etc/blume-watchdog.env; set +a; ./node_modules/.bin/tsx scripts/watchdog.ts --once' >> /var/log/blume-watchdog.log 2>&1
```

`flock -n` keeps a slow pass from overlapping the next one (two writers of one state file). With `--once`, time-based rules need two passes to see a stall, so keep cron at five minutes or less. Rotate the log file; each pass writes one line.

### Watching the watchdog

Set `WATCHDOG_HEARTBEAT_URL` to a dead-man's-switch check (healthchecks.io or similar) with a period of a few minutes: a pass that delivered everything pings it, so a dead process, a full disk or an unreachable webhook becomes a message from somewhere else. The line each pass logs (`nodes 5/5 lcl 12345 xrpl lag 3 findings 0 active 0 sent 0 failed 0`) is the quick health read.

## What it does not do

- It does not touch anything: no pause, no refund, no cap change. It tells a person, and the person decides.
- It does not see inside a node (disk, memory, logs, lease). A node that is up but unhealthy shows as a stalled ledger, a different state hash or a missing vote, not as the cause.
- It does not check an Evernode lease or a TLS certificate's expiry in advance: a lapsed certificate appears as an unreachable node, with the TLS error in the message. Certificates renew with a reload hook (`scripts/front-door/README.md`).
- It trusts the public RPCs it is given. Use two or three, and your own XRPL server first if you run one.
