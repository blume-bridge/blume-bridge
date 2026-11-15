import { Wallet } from 'xrpl'
import { describe, expect, it } from 'vitest'
import { MAX_SIGNERS, accepts, accountSignersNote, analyse, buildPlan, checkOperators, describePlan, disableMasterConfirmation, networkGuard, parseFlags, recoveryFromEnv, sameList, signerListSetTx, submitConfirmation, validatePlan, type OperatorsRead } from '../scripts/signerlist-plan'
import { runSignerList, type AccountRole, type AccountState, type Deps } from '../scripts/testnet-signerlist'

const addr = () => Wallet.generate().classicAddress
const many = (n: number) => Array.from({ length: n }, () => addr())
const ops = (addresses: string[]) => addresses.map((address, i) => ({ address, node: `ed${String(i).padStart(2, '0')}nodepubkey` }))

describe('recoveryFromEnv', () => {
  const cold = addr()
  it('is off unless a signer is named', () => {
    expect(recoveryFromEnv({}, 3)).toBeNull()
    expect(recoveryFromEnv({ RECOVERY_SIGNER: '  ' }, 3)).toBeNull()
  })
  it('defaults the weight to k - 1: useless alone, enough with any one operator', () => {
    expect(recoveryFromEnv({ RECOVERY_SIGNER: cold }, 3)).toEqual({ address: cold, weight: 2 })
    expect(recoveryFromEnv({ RECOVERY_SIGNER: cold }, 5)).toEqual({ address: cold, weight: 4 })
    expect(recoveryFromEnv({ RECOVERY_SIGNER: cold }, 2)).toEqual({ address: cold, weight: 1 })
    expect(recoveryFromEnv({ RECOVERY_SIGNER: cold }, 1)).toEqual({ address: cold, weight: 1 })
  })
  it('takes an explicit weight and rejects nonsense', () => {
    expect(recoveryFromEnv({ RECOVERY_SIGNER: cold, RECOVERY_WEIGHT: '3' }, 3)?.weight).toBe(3)
    for (const bad of ['0', '-1', '1.5', 'two', '65536', '1e3']) expect(() => recoveryFromEnv({ RECOVERY_SIGNER: cold, RECOVERY_WEIGHT: bad }, 3), bad).toThrow(/RECOVERY_WEIGHT/)
    expect(() => recoveryFromEnv({ RECOVERY_SIGNER: 'rNotAnAddress' }, 3)).toThrow(/classic r-address/)
    expect(() => recoveryFromEnv({ RECOVERY_WEIGHT: '2' }, 3)).toThrow(/RECOVERY_SIGNER is not/)
  })
})

describe('building and validating a plan', () => {
  const account = addr()
  it('weights operators 1, sorts by address, and uses k as the quorum', () => {
    const o = many(5)
    const plan = buildPlan({ account, operators: ops(o), k: 3 })
    expect(plan.quorum).toBe(3)
    expect(plan.entries.map((e) => e.address)).toEqual([...o].sort())
    expect(plan.entries.every((e) => e.weight === 1 && e.role === 'operator')).toBe(true)
    expect(validatePlan(plan)).toEqual([])
    expect(signerListSetTx(plan)).toMatchObject({ TransactionType: 'SignerListSet', Account: account, SignerQuorum: 3 })
    expect(signerListSetTx(plan).SignerEntries).toHaveLength(5)
    expect(signerListSetTx(plan).SignerEntries[0]).toEqual({ SignerEntry: { Account: plan.entries[0].address, SignerWeight: 1 } })
  })

  it('works for any n and k, up to the ledger limit of 32', () => {
    for (const [n, k] of [[1, 1], [3, 2], [5, 3], [7, 4], [31, 16], [32, 21]] as const) {
      const plan = buildPlan({ account, operators: ops(many(n)), k })
      expect(validatePlan(plan), `${k} of ${n}`).toEqual([])
    }
    expect(validatePlan(buildPlan({ account, operators: ops(many(MAX_SIGNERS)), k: 3, recovery: { address: addr(), weight: 2 } })).join()).toMatch(/33 entries; XRPL allows 32/)
  })

  it('adds the recovery signer and still validates', () => {
    const plan = buildPlan({ account, operators: ops(many(5)), k: 3, recovery: { address: addr(), weight: 2 } })
    expect(plan.entries).toHaveLength(6)
    expect(plan.entries.filter((e) => e.role === 'recovery')).toHaveLength(1)
    expect(validatePlan(plan)).toEqual([])
  })

  it('refuses what the ledger would refuse', () => {
    const o = many(3)
    const dup = buildPlan({ account, operators: ops([o[0], o[0], o[1]]), k: 2 })
    expect(validatePlan(dup).join()).toMatch(/appears twice/)
    const self = buildPlan({ account, operators: ops([account, o[1], o[2]]), k: 2 })
    expect(validatePlan(self).join()).toMatch(/the account itself/)
    const recoveryIsOperator = buildPlan({ account, operators: ops(o), k: 2, recovery: { address: o[1], weight: 1 } })
    expect(validatePlan(recoveryIsOperator).join()).toMatch(/appears twice/)
    const unreachable = buildPlan({ account, operators: ops(o), k: 4 })
    expect(validatePlan(unreachable).join()).toMatch(/quorum 4 is more than all the weights together \(3\)/)
    expect(validatePlan(buildPlan({ account, operators: ops(o), k: 0 })).join()).toMatch(/quorum must be/)
    expect(validatePlan(buildPlan({ account, operators: [], k: 1 })).join()).toMatch(/no entries/)
    expect(validatePlan(buildPlan({ account, operators: ops(o), k: 2, recovery: { address: addr(), weight: 0 } })).join()).toMatch(/weight 0/)
    expect(validatePlan(buildPlan({ account, operators: ops(o), k: 2, recovery: { address: addr(), weight: 70000 } })).join()).toMatch(/weight 70000/)
    expect(validatePlan(buildPlan({ account, operators: [{ address: 'rBroken' }, ...ops([o[0]])], k: 1 })).join()).toMatch(/not a classic r-address/)
  })
})

describe('who can sign', () => {
  const account = addr()
  const five = () => ops(many(5))

  it('3 of 5: any three operators, nobody alone', () => {
    const a = analyse(buildPlan({ account, operators: five(), k: 3 }))
    expect(a.total).toBe(5)
    expect(a.alone).toEqual([])
    expect(a.combos?.map((c) => c.text)).toEqual(['any 3 of the 5 operator keys'])
  })

  it('a recovery signer of weight k - 1 needs one operator with it, and cannot sign alone', () => {
    const a = analyse(buildPlan({ account, operators: five(), k: 3, recovery: { address: addr(), weight: 2 } }))
    expect(a.alone).toEqual([])
    expect(a.total).toBe(7)
    expect(a.combos?.map((c) => c.text)).toEqual(['any 3 of the 5 operator keys', 'the recovery key (weight 2) plus any 1 of the 5 operator keys'])
  })

  it('a recovery signer of weight k can sign alone, and the analysis says so', () => {
    const rec = addr()
    const plan = buildPlan({ account, operators: five(), k: 3, recovery: { address: rec, weight: 3 } })
    const a = analyse(plan)
    expect(a.alone.map((e) => e.address)).toEqual([rec])
    expect(a.combos?.map((c) => c.text)).toContain('the recovery key (weight 3)')
    // recovery + one operator is not a minimal set when recovery alone suffices
    expect(a.combos?.map((c) => c.text).some((t) => /recovery key.*plus/.test(t))).toBe(false)
    expect(describePlan(plan, 'lock').join('\n')).toMatch(new RegExp(`!!! ${rec} \\(recovery, weight 3\\) CAN SIGN ALONE`))
  })

  it('a weight-1 recovery signer sits between: it replaces one operator', () => {
    const a = analyse(buildPlan({ account, operators: five(), k: 3, recovery: { address: addr(), weight: 1 } }))
    expect(a.combos?.map((c) => c.text)).toEqual(['any 3 of the 5 operator keys', 'the recovery key (weight 1) plus any 2 of the 5 operator keys'])
  })

  it('k = 1 means every operator signs alone, loudly', () => {
    const plan = buildPlan({ account, operators: ops(many(3)), k: 1 })
    const a = analyse(plan)
    expect(a.alone).toHaveLength(3)
    expect(a.combos?.map((c) => c.text)).toEqual(['any 1 of the 3 operator keys'])
    expect(describePlan(plan, 'lock').filter((l) => l.includes('CAN SIGN ALONE'))).toHaveLength(3)
  })

  it('n of n needs every key', () => {
    const a = analyse(buildPlan({ account, operators: ops(many(4)), k: 4 }))
    expect(a.combos?.map((c) => c.text)).toEqual(['all 4 operator keys'])
  })

  it('a single operator with quorum 1 is itself', () => {
    const a = analyse(buildPlan({ account, operators: ops(many(1)), k: 1 }))
    expect(a.combos?.map((c) => c.text)).toEqual(['the operator key'])
    expect(a.alone).toHaveLength(1)
  })

  it('every listed combination reaches the quorum, and none could drop a signer', () => {
    for (const [n, k, w] of [[5, 3, 2], [7, 4, 3], [5, 5, 4], [4, 2, 1]] as const) {
      const plan = buildPlan({ account, operators: ops(many(n)), k, recovery: { address: addr(), weight: w } })
      const a = analyse(plan)
      for (const c of a.combos!) {
        const weight = c.counts.reduce((sum, count, i) => sum + count * a.classes[i].weight, 0)
        expect(weight, c.text).toBeGreaterThanOrEqual(k)
        c.counts.forEach((count, i) => count > 0 && expect(weight - a.classes[i].weight, c.text).toBeLessThan(k))
      }
    }
  })

  it('prints the plan, the signers, the combinations and the verdict', () => {
    const plan = buildPlan({ account, operators: five(), k: 3, recovery: { address: addr(), weight: 2 } })
    const text = describePlan(plan, 'funding').join('\n')
    expect(text).toContain(`funding ${account}: quorum 3, 6 entries, total weight 7`)
    expect(text).toContain('These combinations can sign:')
    expect(text).toContain('No single entry can sign alone.')
    expect(text).toContain('recovery')
  })

  it('names the master key and a regular key, which sign alone whatever the list says', () => {
    expect(accountSignersNote({ masterDisabled: false, regularKey: null }).join('\n')).toMatch(/Master key: ENABLED/)
    expect(accountSignersNote({ masterDisabled: true, regularKey: null })).toEqual(['    Master key: disabled.'])
    expect(accountSignersNote({ masterDisabled: true, regularKey: 'rRegular' }).join('\n')).toMatch(/!!! A regular key \(rRegular\) is set: that ONE key can sign alone/)
  })

  it('compares with the ledger on weights as well as members', () => {
    const plan = buildPlan({ account, operators: five(), k: 3, recovery: { address: addr(), weight: 2 } })
    const onLedger = { quorum: 3, entries: plan.entries.map((e) => ({ address: e.address, weight: e.weight })) }
    expect(sameList(onLedger, plan)).toBe(true)
    expect(sameList(null, plan)).toBe(false)
    expect(sameList({ ...onLedger, quorum: 2 }, plan)).toBe(false)
    expect(sameList({ ...onLedger, entries: onLedger.entries.map((e, i) => (i === 0 ? { ...e, weight: e.weight + 1 } : e)) }, plan)).toBe(false)
    expect(sameList({ ...onLedger, entries: onLedger.entries.slice(1) }, plan)).toBe(false)
  })
})

describe('the operator set the cluster reports', () => {
  const lock = addr()
  const funding = addr()
  const read = (over: Partial<OperatorsRead> = {}): OperatorsRead => {
    const signers = many(5).map((xrplAddress, i) => ({ node: `ed${i}`, xrplAddress }))
    return { k: 3, n: 5, ready: true, lockAccount: lock, fundingAccount: funding, signers, ...over }
  }
  it('accepts a ready set that belongs to these accounts', () => {
    expect(checkOperators(read(), { lock, funding }, true)).toEqual({ errors: [], warnings: [] })
  })
  it('refuses another cluster\'s operators', () => {
    const r = checkOperators(read({ lockAccount: addr() }), { lock, funding }, false)
    expect(r.errors.join()).toMatch(/another cluster's operator set/)
    expect(checkOperators(read({ fundingAccount: addr() }), { lock, funding }, false).errors).toHaveLength(1)
  })
  it('refuses a set that is not ready or does not add up', () => {
    expect(checkOperators(read({ ready: false }), { lock, funding }, false).errors.join()).toMatch(/not agreed yet/)
    expect(checkOperators(read({ n: 6 }), { lock, funding }, false).errors.join()).toMatch(/n=6 but lists 5/)
    expect(checkOperators(read({ k: 6 }), { lock, funding }, false).errors.join()).toMatch(/k=6 n=5/)
    expect(checkOperators(read({ signers: [] }), { lock, funding }, false).errors.join()).toMatch(/no operators/)
    const a = addr()
    expect(checkOperators(read({ n: 2, k: 1, signers: [{ node: 'x', xrplAddress: a }, { node: 'y', xrplAddress: a }] }), { lock, funding }, false).errors.join()).toMatch(/listed for two operators/)
  })
  it('a cluster that does not name its accounts cannot be matched: a warning on a test network, an error on mainnet', () => {
    const unnamed = read({ lockAccount: undefined, fundingAccount: undefined })
    expect(checkOperators(unnamed, { lock, funding }, false).warnings).toHaveLength(2)
    expect(checkOperators(unnamed, { lock, funding }, false).errors).toEqual([])
    expect(checkOperators(unnamed, { lock, funding }, true).errors).toHaveLength(2)
  })
})

describe('guards', () => {
  it('mainnet needs BRIDGE_QUERY set explicitly', () => {
    expect(networkGuard({ network: 'mainnet', bridgeQuery: undefined })).toMatchObject({ ok: false })
    expect(networkGuard({ network: 'mainnet', bridgeQuery: '' })).toMatchObject({ ok: false })
    expect(networkGuard({ network: 'mainnet', bridgeQuery: '   ' })).toMatchObject({ ok: false })
    expect(networkGuard({ network: 'mainnet', bridgeQuery: 'node q.js host:8091 {}' })).toEqual({ ok: true })
    expect(networkGuard({ network: 'devnet', bridgeQuery: undefined })).toEqual({ ok: true })
    expect(networkGuard({ network: 'testnet', bridgeQuery: undefined })).toEqual({ ok: true })
    const refused = networkGuard({ network: 'mainnet', bridgeQuery: undefined })
    expect(refused.ok === false && refused.reason).toMatch(/dev cluster/)
  })

  it('knows its flags and nothing else', () => {
    expect(parseFlags([])).toEqual({ yes: false, dryRun: false, disableMaster: false, confirmDisableMaster: false })
    expect(parseFlags(['--yes', '--dry-run'])).toMatchObject({ yes: true, dryRun: true })
    expect(() => parseFlags(['--force'])).toThrow(/unknown argument --force/)
    expect(() => parseFlags(['--confirm-disable-master'])).toThrow(/only goes with --disable-master/)
  })

  it('submitting needs --yes or a typed YES; a dry run needs nothing', () => {
    const f = (o: Partial<ReturnType<typeof parseFlags>>) => ({ ...parseFlags([]), ...o })
    expect(submitConfirmation(f({ dryRun: true }), false)).toEqual({ kind: 'none' })
    expect(submitConfirmation(f({ yes: true }), false)).toEqual({ kind: 'flag' })
    expect(submitConfirmation(f({}), true)).toEqual({ kind: 'typed', expect: 'YES' })
    expect(submitConfirmation(f({}), false)).toMatchObject({ kind: 'refuse' })
  })

  it('disabling the master key is its own confirmation, and --yes is not it', () => {
    const f = (o: Partial<ReturnType<typeof parseFlags>>) => ({ ...parseFlags([]), ...o })
    expect(disableMasterConfirmation(f({}), false)).toEqual({ kind: 'none' })
    expect(disableMasterConfirmation(f({ disableMaster: true, dryRun: true }), false)).toEqual({ kind: 'none' })
    const withYes = disableMasterConfirmation(f({ disableMaster: true, yes: true }), false)
    expect(withYes).toMatchObject({ kind: 'refuse' })
    expect(withYes.kind === 'refuse' && withYes.reason).toMatch(/--yes does not cover it/)
    expect(disableMasterConfirmation(f({ disableMaster: true, yes: true }), true)).toEqual({ kind: 'typed', expect: 'DISABLE MASTER' })
    expect(disableMasterConfirmation(f({ disableMaster: true, confirmDisableMaster: true }), false)).toEqual({ kind: 'flag' })
  })

  it('accepts exactly the phrase', () => {
    const yes = { kind: 'typed', expect: 'YES' } as const
    expect(accepts(yes, 'YES')).toBe(true)
    expect(accepts(yes, ' YES\n')).toBe(true)
    for (const no of ['yes', 'Y', 'y', 'YES!', '', 'NO', 'YES YES']) expect(accepts(yes, no), no).toBe(false)
    expect(accepts({ kind: 'typed', expect: 'DISABLE MASTER' }, 'DISABLE')).toBe(false)
    expect(accepts({ kind: 'refuse', reason: 'x' }, 'YES')).toBe(false)
  })
})

// ------------------------------------------------------------------ the whole flow, with fakes

describe('runSignerList', () => {
  const lock = addr()
  const funding = addr()
  const operators = many(5)
  const operatorsRead = (over: Partial<OperatorsRead> = {}): OperatorsRead => ({ k: 3, n: 5, ready: true, lockAccount: lock, fundingAccount: funding, signers: operators.map((xrplAddress, i) => ({ node: `ed${i}00000000`, xrplAddress })), ...over })

  interface Fake {
    deps: Deps
    logs: string[]
    submitted: { role: AccountRole; tx: Record<string, unknown>; label: string }[]
    prompts: string[]
    reads: { operators: number; accounts: number }
    ledger: Record<AccountRole, AccountState>
  }
  function fake(opts: { network?: string; interactive?: boolean; typed?: string[]; ops?: OperatorsRead; ledger?: Partial<Record<AccountRole, Partial<AccountState>>>; applySubmits?: boolean; proofs?: Record<string, string> } = {}): Fake {
    const logs: string[] = []
    const submitted: Fake['submitted'] = []
    const prompts: string[] = []
    const reads = { operators: 0, accounts: 0 }
    const blank = (): AccountState => ({ masterDisabled: false, regularKey: null, balanceXrp: '25', list: null })
    const ledger: Fake['ledger'] = { lock: { ...blank(), ...opts.ledger?.lock }, funding: { ...blank(), ...opts.ledger?.funding } }
    const typed = [...(opts.typed ?? [])]
    const deps: Deps = {
      networkName: opts.network ?? 'mainnet',
      networkLabel: opts.network === 'devnet' ? 'XRPL Devnet' : 'XRP Ledger',
      accounts: () => ({ lock, funding }),
      keysPath: () => 'keys/mainnet.json',
      readOperators: () => {
        reads.operators++
        return opts.ops ?? operatorsRead()
      },
      readAccounts: async () => {
        reads.accounts++
        return structuredClone(ledger)
      },
      submit: async (role, tx, label) => {
        submitted.push({ role, tx, label })
        // the ledger takes a SignerListSet the way the ledger would
        if (opts.applySubmits !== false && tx.TransactionType === 'SignerListSet') {
          ledger[role].list = { quorum: Number(tx.SignerQuorum), entries: (tx.SignerEntries as { SignerEntry: { Account: string; SignerWeight: number } }[]).map((e) => ({ address: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight })) }
        }
        if (tx.TransactionType === 'AccountSet') ledger[role].masterDisabled = true
      },
      verifyMultisigned: async (address, hash) => (opts.proofs?.[hash] === address ? null : `transaction ${hash} is not a validated multisigned transaction from ${address}`),
      prompt: async (q) => {
        prompts.push(q)
        return typed.shift() ?? ''
      },
      log: (l) => logs.push(l),
      interactive: opts.interactive ?? false,
    }
    return { deps, logs, submitted, prompts, reads, ledger }
  }
  const query = { BRIDGE_QUERY: 'node q.js mainnet-node:8091 {}' }
  // The hashes of a validated multisigned transaction from each account, which --disable-master reads from the ledger before it touches anything.
  const proofs = { LOCKPROOF: lock, FUNDINGPROOF: funding }
  const withProof = { ...query, PROOF_LOCK: 'LOCKPROOF', PROOF_FUNDING: 'FUNDINGPROOF' }
  const out = (f: Fake) => f.logs.join('\n')

  it('refuses mainnet without BRIDGE_QUERY before it reads anything', async () => {
    const f = fake()
    await expect(runSignerList(['--yes'], {}, f.deps)).rejects.toThrow(/BRIDGE_QUERY set explicitly/)
    expect(f.reads).toEqual({ operators: 0, accounts: 0 })
    expect(f.submitted).toEqual([])
    // a test network is fine with the default
    const dev = fake({ network: 'devnet' })
    await runSignerList(['--dry-run'], {}, dev.deps)
    expect(dev.reads.operators).toBe(1)
    expect(out(dev)).toContain('the DEFAULT dev cluster')
  })

  it('--dry-run prints the signers, the quorum, the account and the transactions, and signs nothing', async () => {
    const cold = addr()
    const f = fake()
    await runSignerList(['--dry-run'], { ...query, RECOVERY_SIGNER: cold }, f.deps)
    const text = out(f)
    expect(text).toContain('DRY RUN: nothing is signed or submitted')
    expect(text).toContain(`lock ${lock}: quorum 3, 6 entries, total weight 7`)
    expect(text).toContain(`funding ${funding}: quorum 3, 6 entries, total weight 7`)
    for (const o of operators) expect(text).toContain(o)
    expect(text).toContain(cold)
    expect(text).toContain('the recovery key (weight 2) plus any 1 of the 5 operator keys')
    expect(text).toContain('No single entry can sign alone.')
    expect(text).toContain('Master key: ENABLED')
    expect(text).toContain('"TransactionType": "SignerListSet"')
    expect(text).toContain('"SignerQuorum": 3')
    expect(text).toContain(`"Account": "${lock}"`)
    expect(f.submitted).toEqual([])
    expect(f.prompts).toEqual([])
  })

  it('says loudly when a recovery signer can sign alone', async () => {
    const f = fake()
    await runSignerList(['--dry-run'], { ...query, RECOVERY_SIGNER: addr(), RECOVERY_WEIGHT: '3' }, f.deps)
    expect(out(f)).toContain('CAN SIGN ALONE')
  })

  it('submits nothing without --yes or a typed YES', async () => {
    const f = fake()
    await expect(runSignerList([], query, f.deps)).rejects.toThrow(/nothing is submitted without --yes/)
    expect(f.submitted).toEqual([])
    const typedNo = fake({ interactive: true, typed: ['no'] })
    await expect(runSignerList([], query, typedNo.deps)).rejects.toThrow(/not confirmed/)
    expect(typedNo.submitted).toEqual([])
    expect(typedNo.prompts[0]).toContain('Type YES to submit')
    expect(typedNo.prompts[0]).toContain(lock)
    const lower = fake({ interactive: true, typed: ['yes'] })
    await expect(runSignerList([], query, lower.deps)).rejects.toThrow(/not confirmed/)
  })

  it('--yes installs the lists on both accounts and leaves the master keys alone', async () => {
    const f = fake()
    await runSignerList(['--yes'], query, f.deps)
    expect(f.submitted.map((s) => `${s.role}:${s.tx.TransactionType}`)).toEqual(['lock:SignerListSet', 'funding:SignerListSet'])
    expect(f.submitted[0].tx).toMatchObject({ Account: lock, SignerQuorum: 3 })
    expect((f.submitted[0].tx.SignerEntries as unknown[]).length).toBe(5)
    expect(f.prompts).toEqual([])
  })

  it('a typed YES at a terminal installs them', async () => {
    const f = fake({ interactive: true, typed: ['YES'] })
    await runSignerList([], query, f.deps)
    expect(f.submitted).toHaveLength(2)
  })

  it('does not resubmit a list that is already exactly right', async () => {
    const first = fake()
    await runSignerList(['--yes'], query, first.deps)
    const f = fake({ ledger: { lock: { list: first.ledger.lock.list }, funding: { list: first.ledger.funding.list } } })
    await runSignerList(['--yes'], query, f.deps)
    expect(f.submitted).toEqual([])
    expect(out(f)).toContain('Nothing to do')
  })

  it('--disable-master asks again and --yes does not answer it', async () => {
    const f = fake({ proofs })
    await expect(runSignerList(['--yes', '--disable-master'], withProof, f.deps)).rejects.toThrow(/--yes does not cover it/)
    // the lists went in; the master keys did not go
    expect(f.submitted.map((s) => s.tx.TransactionType)).toEqual(['SignerListSet', 'SignerListSet'])
    expect(f.ledger.lock.masterDisabled).toBe(false)
    expect(out(f)).toContain('IRREVERSIBLE')
    expect(out(f)).toMatch(/There is no undo/)
  })

  it('--disable-master with its own confirmation disables both, after checking the lists are on the ledger', async () => {
    const f = fake({ proofs })
    await runSignerList(['--yes', '--disable-master', '--confirm-disable-master'], withProof, f.deps)
    expect(f.submitted.map((s) => `${s.role}:${s.tx.TransactionType}`)).toEqual(['lock:SignerListSet', 'funding:SignerListSet', 'lock:AccountSet', 'funding:AccountSet'])
    expect(f.submitted[2].tx).toMatchObject({ SetFlag: 4, Account: lock })
    expect(f.reads.accounts).toBe(2)
  })

  it('a typed DISABLE MASTER at a terminal is the second confirmation', async () => {
    const f = fake({ interactive: true, typed: ['YES', 'DISABLE MASTER'], proofs })
    await runSignerList(['--disable-master'], withProof, f.deps)
    expect(f.prompts).toHaveLength(2)
    expect(f.prompts[1]).toContain('DISABLE MASTER')
    expect(f.submitted.filter((s) => s.tx.TransactionType === 'AccountSet')).toHaveLength(2)
    const wrong = fake({ interactive: true, typed: ['YES', 'yes'], proofs })
    await expect(runSignerList(['--disable-master'], withProof, wrong.deps)).rejects.toThrow(/not confirmed/)
    expect(wrong.submitted.filter((s) => s.tx.TransactionType === 'AccountSet')).toEqual([])
  })

  it('never disables a master key behind a list the ledger does not hold', async () => {
    const f = fake({ applySubmits: false, proofs })
    await expect(runSignerList(['--yes', '--disable-master', '--confirm-disable-master'], withProof, f.deps)).rejects.toThrow(/not the planned one after the submit; the master key stays enabled/)
    expect(f.submitted.filter((s) => s.tx.TransactionType === 'AccountSet')).toEqual([])
  })

  it('a dry run of --disable-master shows the AccountSet and says it needs its own confirmation', async () => {
    const f = fake()
    await runSignerList(['--dry-run', '--disable-master'], query, f.deps)
    expect(out(f)).toContain('"TransactionType": "AccountSet"')
    expect(out(f)).toContain('"SetFlag": 4')
    expect(out(f)).toMatch(/only after a second, separate confirmation/)
    expect(f.submitted).toEqual([])
  })

  it('explains when a master key is already disabled and the list must change', async () => {
    const f = fake({ ledger: { lock: { masterDisabled: true } } })
    await expect(runSignerList(['--yes'], query, f.deps)).rejects.toThrow(/master key disabled.*multisigned/)
    expect(f.submitted).toEqual([])
  })

  it('refuses another cluster\'s operators before it reads the ledger', async () => {
    const f = fake({ ops: operatorsRead({ lockAccount: addr() }) })
    await expect(runSignerList(['--yes'], query, f.deps)).rejects.toThrow(/another cluster's operator set/)
    expect(f.reads.accounts).toBe(0)
    expect(f.submitted).toEqual([])
  })

  it('refuses an invalid plan (a recovery signer that is also an operator) before it reads the ledger', async () => {
    const f = fake()
    await expect(runSignerList(['--yes'], { ...query, RECOVERY_SIGNER: operators[0] }, f.deps)).rejects.toThrow(/appears twice/)
    expect(f.reads.accounts).toBe(0)
  })

  it('will not disable a master key without proof that k operators have multisigned from the account', async () => {
    const none = fake({ proofs })
    await expect(runSignerList(['--yes', '--disable-master', '--confirm-disable-master'], query, none.deps)).rejects.toThrow(/PROOF_LOCK=/)
    expect(none.submitted).toEqual([]) // nothing at all went out: the check comes before the first submit
    const wrongAccount = fake({ proofs: { LOCKPROOF: funding, FUNDINGPROOF: funding } })
    await expect(runSignerList(['--yes', '--disable-master', '--confirm-disable-master'], withProof, wrongAccount.deps)).rejects.toThrow(/lock: transaction LOCKPROOF is not a validated multisigned transaction.*master key stays enabled/)
    expect(wrongAccount.submitted).toEqual([])
    const onlyOne = fake({ proofs: { LOCKPROOF: lock } })
    await expect(runSignerList(['--yes', '--disable-master', '--confirm-disable-master'], withProof, onlyOne.deps)).rejects.toThrow(/funding: /)
    expect(onlyOne.submitted).toEqual([])
  })

  it('will not disable a master key while the account has a regular key that signs alone', async () => {
    const f = fake({ proofs, ledger: { lock: { regularKey: addr() } } })
    await expect(runSignerList(['--yes', '--disable-master', '--confirm-disable-master'], withProof, f.deps)).rejects.toThrow(/lock has a regular key/)
    expect(f.submitted).toEqual([])
  })

  it('does not ask for proof of an account whose master key is already gone', async () => {
    const f = fake({ proofs: {}, ledger: { lock: { masterDisabled: true }, funding: { masterDisabled: true } } })
    const first = fake()
    await runSignerList(['--yes'], query, first.deps)
    const both = fake({ ledger: { lock: { masterDisabled: true, list: first.ledger.lock.list }, funding: { masterDisabled: true, list: first.ledger.funding.list } } })
    await runSignerList(['--yes', '--disable-master', '--confirm-disable-master'], query, both.deps)
    expect(both.submitted).toEqual([])
    expect(f.submitted).toEqual([])
  })

  it('never prints anything that looks like a seed', async () => {
    const f = fake({ proofs })
    await runSignerList(['--yes', '--disable-master', '--confirm-disable-master'], withProof, f.deps)
    expect(out(f)).not.toMatch(/\bs[1-9A-HJ-NP-Za-km-z]{24,}\b/)
  })
})
