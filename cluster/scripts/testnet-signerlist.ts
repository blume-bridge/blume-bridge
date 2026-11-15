/**
 * Puts the cluster's operator keys on the lock and funding accounts as a SignerList (quorum k), optionally with a cold
 * recovery signer, and optionally disables the master keys. Signed by the accounts' master keys from keys/<network>.json
 * (XRPL_NETWORK, devnet by default; XRPL_NETWORK=mainnet with KEYS_PATH pointed at the mainnet key file does the real
 * thing). Seeds are read only to sign and are never printed.
 *
 * A SignerList decides who can move every locked token, and --disable-master makes it permanent, so this script does
 * nothing until it has shown what it is about to do:
 *   - XRPL_NETWORK=mainnet is refused unless BRIDGE_QUERY is set. The default operator source is the dev cluster on
 *     localhost:8081, whose keys would otherwise land on the mainnet accounts.
 *   - The operator set must belong to the cluster that watches these accounts (its lockAccount and fundingAccount
 *     must be the key file's), be ready, and be n distinct addresses.
 *   - It prints each account, the signers and weights, the quorum, every combination that can sign, and, loudly,
 *     whether any single entry (a signer, the master key, a regular key) can sign alone.
 *   - It submits only with --yes, or a typed YES at a terminal. --dry-run prints the transactions and signs nothing.
 *   - --disable-master asks a second, separate question that says it cannot be undone. --yes does not answer it:
 *     it needs --confirm-disable-master or a typed DISABLE MASTER. After it the lists can only change by a multisigned
 *     SignerListSet from the current signers, which this script cannot make.
 *
 * The operator set comes from whatever command BRIDGE_QUERY runs, which must print the cluster's `operators` read as
 * JSON. execSync hands the command to sh, so the JSON's own quotes have to survive one round of shell quoting or the
 * read arrives as {type:operators} and the cluster answers with an unknown-read error.
 *
 *   npx tsx scripts/testnet-signerlist.ts --dry-run          # devnet, the dev cluster over ssh: show, sign nothing
 *   npx tsx scripts/testnet-signerlist.ts --yes              # the same, and submit
 *   BRIDGE_QUERY='ssh node1 "cd /root/bridge-cluster-main/client && node query/index.js localhost:8091 \"{\\\"type\\\":\\\"operators\\\"}\""' \
 *     XRPL_NETWORK=mainnet KEYS_PATH=keys/mainnet.json RECOVERY_SIGNER=rXXXX... npx tsx scripts/testnet-signerlist.ts --dry-run
 *   PROOF_LOCK=<tx hash> PROOF_FUNDING=<tx hash> ... --disable-master   # after the lists are in and each account has made a multisigned payment:
 *                                 # the script reads both from the ledger and refuses unless k operators signed each
 *
 * Env: BRIDGE_QUERY, XRPL_NETWORK, KEYS_PATH, PROOF_LOCK / PROOF_FUNDING (with --disable-master), RECOVERY_SIGNER (a cold signer added to both lists), RECOVERY_WEIGHT
 * (default k - 1: useless alone, enough with any one operator). Flags: --dry-run, --yes, --disable-master,
 * --confirm-disable-master.
 */
import { execSync } from 'node:child_process'
import readline from 'node:readline/promises'
import type { Client } from 'xrpl'
import { accepts, accountSignersNote, buildPlan, checkOperators, describePlan, disableMasterConfirmation, networkGuard, parseFlags, recoveryFromEnv, sameList, signerListSetTx, submitConfirmation, validatePlan, type Confirmation, type LedgerSignerList, type OperatorsRead, type Plan } from './signerlist-plan'
import { keysPath, loadKeys, network, submit, wallet, withClient, xrplNetwork } from './testnet-lib'

const ASF_DISABLE_MASTER = 4
const LSF_DISABLE_MASTER = 0x00100000
const DEFAULT_QUERY = `ssh bridge-host 'cd /root/bridge-cluster/client && node query/index.js localhost:8081 "{\\"type\\":\\"operators\\"}"'`
const ROLES = ['lock', 'funding'] as const
export type AccountRole = (typeof ROLES)[number]

export interface AccountState {
  masterDisabled: boolean
  regularKey: string | null
  balanceXrp: string
  list: LedgerSignerList | null
}

/** Everything that touches the outside world, so the flow can be tested with fakes. */
export interface Deps {
  networkName: string
  networkLabel: string
  /** The addresses of the lock and funding accounts, from the key file (seeds stay inside submit). Null when there is no key file. */
  accounts(): Record<AccountRole, string> | null
  keysPath(): string
  /** Runs BRIDGE_QUERY (or the default) and returns the cluster's `operators` read. */
  readOperators(query: string): OperatorsRead
  readAccounts(accounts: Record<AccountRole, string>): Promise<Record<AccountRole, AccountState>>
  /** Signs with the account's master key and submits. */
  submit(role: AccountRole, tx: Record<string, unknown>, label: string): Promise<void>
  /** Whether `hash` is a validated, successful transaction from `address` that was multisigned by at least `k` signers; null when it is, else why not. */
  verifyMultisigned(address: string, hash: string, k: number): Promise<string | null>
  prompt(question: string): Promise<string>
  log(line: string): void
  interactive: boolean
}

async function confirm(deps: Deps, c: Confirmation, prompt: string): Promise<void> {
  if (c.kind === 'none' || c.kind === 'flag') return
  if (c.kind === 'refuse') throw new Error(c.reason)
  if (!accepts(c, await deps.prompt(prompt))) throw new Error('not confirmed; nothing was submitted')
}

export async function runSignerList(argv: string[], env: Record<string, string | undefined>, deps: Deps): Promise<void> {
  const flags = parseFlags(argv)
  const { log } = deps
  const guard = networkGuard({ network: deps.networkName, bridgeQuery: env.BRIDGE_QUERY })
  if (!guard.ok) throw new Error(guard.reason)
  const explicit = !!env.BRIDGE_QUERY?.trim()
  const query = explicit ? env.BRIDGE_QUERY! : DEFAULT_QUERY
  const accounts = deps.accounts()
  if (!accounts) throw new Error(`no keys for ${deps.networkLabel} at ${deps.keysPath()}: run XRPL_NETWORK=${deps.networkName} npx tsx scripts/testnet-setup.ts first`)

  log(`  ${deps.networkLabel} (${deps.networkName})${flags.dryRun ? ', DRY RUN: nothing is signed or submitted' : ''}`)
  log(`  operator set from ${explicit ? 'BRIDGE_QUERY' : 'the DEFAULT dev cluster (BRIDGE_QUERY is not set)'}: ${query}`)
  const ops = deps.readOperators(query)
  log(`  cluster operators: k=${ops.k} n=${ops.n} ready=${ops.ready}`)
  for (const s of ops.signers ?? []) log(`    ${String(s.node).slice(0, 10)} -> ${s.xrplAddress}`)
  const checked = checkOperators(ops, accounts, deps.networkName === 'mainnet')
  for (const w of checked.warnings) log(`  WARNING: ${w}`)
  if (checked.errors.length) throw new Error(`refusing this operator set:\n    ${checked.errors.join('\n    ')}`)

  const recovery = recoveryFromEnv(env, ops.k)
  const operators = ops.signers.map((s) => ({ address: s.xrplAddress, node: s.node }))
  const plans = { lock: buildPlan({ account: accounts.lock, operators, k: ops.k, recovery }), funding: buildPlan({ account: accounts.funding, operators, k: ops.k, recovery }) } satisfies Record<AccountRole, Plan>
  const invalid = ROLES.flatMap((r) => validatePlan(plans[r]).map((e) => `${r}: ${e}`))
  if (invalid.length) throw new Error(`the signer list would be invalid:\n    ${invalid.join('\n    ')}`)
  if (!recovery) log('  NOTE: no recovery signer (RECOVERY_SIGNER). Losing more than n-k node keys would lose both accounts for good.')

  const state = await deps.readAccounts(accounts)
  log('')
  log(flags.dryRun ? '  This is what would be installed:' : '  This is what is about to be installed:')
  for (const r of ROLES) {
    for (const line of describePlan(plans[r], r)) log(`  ${line}`)
    for (const line of accountSignersNote(state[r])) log(`  ${line}`)
    const now = state[r].list
    log(`      on the ledger now: ${now ? `quorum ${now.quorum}, ${now.entries.length} entries${sameList(now, plans[r]) ? ' (already exactly this)' : ' (will be replaced)'}` : 'no signer list'}; balance ${state[r].balanceXrp} XRP`)
  }
  if (recovery) log(`  The recovery signer ${recovery.address} (weight ${recovery.weight}) is on both lists. It must be a cold key: with it, the quorum needs ${Math.max(0, ops.k - recovery.weight)} more operator signature(s).`)

  const todo = ROLES.filter((r) => !sameList(state[r].list, plans[r]))
  const disable = flags.disableMaster ? ROLES.filter((r) => !state[r].masterDisabled) : []
  const txs = [...todo.map((r) => ({ label: `${r} SignerListSet`, tx: signerListSetTx(plans[r]) as unknown as Record<string, unknown> })), ...disable.map((r) => ({ label: `${r} disable master (irreversible)`, tx: { TransactionType: 'AccountSet', Account: accounts[r], SetFlag: ASF_DISABLE_MASTER } as Record<string, unknown> }))]

  if (flags.dryRun) {
    log('')
    log(txs.length ? '  Transactions that would be submitted (Sequence, Fee and LastLedgerSequence are filled in at submit time):' : '  Nothing to submit: the lists are already in place.')
    for (const t of txs) log(`  -- ${t.label}\n${JSON.stringify(t.tx, null, 2).replace(/^/gm, '     ')}`)
    if (disable.length) log('  The AccountSet above would be submitted only after a second, separate confirmation.')
    return
  }

  for (const r of todo) if (state[r].masterDisabled) throw new Error(`${r} ${accounts[r]} has its master key disabled, so this script cannot change its list: a SignerListSet now has to be multisigned by the current signers.`)
  if (!todo.length && !disable.length) {
    log('  Nothing to do: the lists are already in place.')
    return
  }

  // The master key is the only way back from a list nobody can sign for. It goes only after the operators have shown they can sign: a validated, multisigned transaction from each account, by k of them, on this ledger.
  for (const r of disable) {
    if (state[r].regularKey) throw new Error(`${r} has a regular key (${state[r].regularKey}), which signs alone whatever the list says. Remove it (SetRegularKey with no key) before the master key goes.`)
    const proof = env[r === 'lock' ? 'PROOF_LOCK' : 'PROOF_FUNDING']?.trim()
    if (!proof) throw new Error(`--disable-master needs PROOF_${r.toUpperCase()}=<hash of a validated transaction from the ${r} account that k operators multisigned>. Install the lists first, make one small multisigned payment from each account (the cluster does it for a release or a payout), then pass the hashes.`)
    const bad = await deps.verifyMultisigned(accounts[r], proof, ops.k)
    if (bad) throw new Error(`${r}: ${bad}. The master key stays enabled.`)
    log(`  ${r}: ${proof.slice(0, 10)}… is a validated multisigned transaction from the account (at least ${ops.k} signers). Good.`)
  }

  if (todo.length) {
    await confirm(deps, submitConfirmation(flags, deps.interactive), `\n  Install these lists on ${todo.map((r) => `${r} ${accounts[r]}`).join(' and ')} on ${deps.networkLabel}? Type YES to submit: `)
    for (const r of todo) await deps.submit(r, signerListSetTx(plans[r]) as unknown as Record<string, unknown>, `${r} SignerListSet quorum ${plans[r].quorum} of ${plans[r].entries.length} entries`)
  }

  if (disable.length) {
    // The lists must be on the ledger exactly as planned before the master key goes: a master key disabled behind a wrong list is an account nobody can sign for.
    const verified = await deps.readAccounts(accounts)
    for (const r of ROLES) if (!sameList(verified[r].list, plans[r])) throw new Error(`${r}: the list on the ledger is not the planned one after the submit; the master key stays enabled`)
    log('')
    log('  !!! IRREVERSIBLE !!!')
    log(`  This disables the master key of ${disable.map((r) => `${r} ${accounts[r]}`).join(' and ')}.`)
    log('  After it, the account can only be signed for by the signer lists printed above. If enough of those keys are lost, the XRP and every token in it are lost for good.')
    log('  There is no undo: not by Ripple, not by us. Changing a list later needs a multisigned SignerListSet from the current signers.')
    await confirm(deps, disableMasterConfirmation(flags, deps.interactive), '  Type DISABLE MASTER to continue: ')
    for (const r of disable) await deps.submit(r, { TransactionType: 'AccountSet', Account: accounts[r], SetFlag: ASF_DISABLE_MASTER }, `${r} disable master`)
  }
}

// ------------------------------------------------------------------ the real world

function realDeps(): Deps {
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY)
  async function readAccount(client: Client, address: string): Promise<AccountState> {
    let info
    try {
      info = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' })
    } catch (e) {
      if (/actNotFound/.test(String((e as { data?: { error?: string } }).data?.error ?? (e as Error).message))) throw new Error(`${address} does not exist on ${network().label}: fund it first`)
      throw e
    }
    const data = info.result.account_data as { Flags: number; RegularKey?: string; Balance: string }
    const objects = await client.request({ command: 'account_objects', account: address, type: 'signer_list', ledger_index: 'validated' })
    const found = (objects.result.account_objects as { SignerQuorum: number; SignerEntries: { SignerEntry: { Account: string; SignerWeight: number } }[] }[])[0]
    return {
      masterDisabled: (data.Flags & LSF_DISABLE_MASTER) !== 0,
      regularKey: data.RegularKey ?? null,
      balanceXrp: (Number(data.Balance) / 1e6).toString(),
      list: found ? { quorum: found.SignerQuorum, entries: found.SignerEntries.map((e) => ({ address: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight })) } : null,
    }
  }
  return {
    networkName: xrplNetwork(),
    networkLabel: network().label,
    accounts: () => {
      const keys = loadKeys()
      return keys ? { lock: keys.lock.address, funding: keys.funding.address } : null
    },
    keysPath,
    readOperators: (query) => {
      const raw = execSync(query, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }).toString()
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start < 0 || end < start) throw new Error(`BRIDGE_QUERY printed no JSON: ${raw.slice(0, 200)}`)
      return JSON.parse(raw.slice(start, end + 1)) as OperatorsRead
    },
    readAccounts: (accounts) =>
      withClient(async (client) => {
        const out = {} as Record<AccountRole, AccountState>
        for (const r of ROLES) out[r] = await readAccount(client, accounts[r])
        return out
      }),
    submit: async (role, tx, label) => {
      const keys = loadKeys()
      if (!keys) throw new Error('the key file went away')
      await withClient((client) => submit(client, wallet(keys, role), tx, label))
    },
    verifyMultisigned: (address, hash, k) =>
      withClient(async (client) => {
        let r
        try {
          r = await client.request({ command: 'tx', transaction: hash })
        } catch (e) {
          return `transaction ${hash} could not be read (${String((e as { data?: { error?: string } }).data?.error ?? (e as Error).message)})`
        }
        const result = r.result as unknown as { validated?: boolean; tx_json?: Record<string, unknown>; meta?: { TransactionResult?: string } } & Record<string, unknown>
        const tx = (result.tx_json ?? result) as { Account?: string; SigningPubKey?: string; Signers?: unknown[] }
        if (!result.validated) return `transaction ${hash} is not in a validated ledger yet`
        if (tx.Account !== address) return `transaction ${hash} is from ${tx.Account}, not ${address}`
        if (result.meta?.TransactionResult !== 'tesSUCCESS') return `transaction ${hash} did not succeed (${result.meta?.TransactionResult})`
        if (tx.SigningPubKey !== '' || !Array.isArray(tx.Signers)) return `transaction ${hash} was signed with a single key, not multisigned`
        if (tx.Signers.length < k) return `transaction ${hash} carries ${tx.Signers.length} signatures, fewer than the ${k} the list needs`
        return null
      }),
    prompt: async (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      try {
        return await rl.question(question)
      } finally {
        rl.close()
      }
    },
    log: (line) => console.log(line),
    interactive,
  }
}

if (require.main === module) {
  // realDeps() reads XRPL_NETWORK, which throws for a name it does not know: inside the promise, so it prints as one ERROR line.
  ;(async () => runSignerList(process.argv.slice(2), process.env, realDeps()))().catch((e) => {
    const data = e?.data
    console.error('ERROR', data?.error_message ?? data?.error ?? e?.message ?? e)
    process.exit(1)
  })
}
