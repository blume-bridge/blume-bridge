import { describe, expect, it } from 'vitest'
import { encodeForMultisigning } from 'ripple-binary-codec'
import { decodeAccountID } from 'ripple-address-codec'
import { sign as signRaw } from 'ripple-keypairs'
import { Wallet, decode } from 'xrpl'
import { assemble, ingestSignatures } from '../src/signing'
import type { ActionRec, SignerEntry, State } from '../src/types'
import genesis from '../genesis/dev.json'

const LOCK = genesis.config.xrpl.lockAccount
const ALICE = 'rJfqVsXN3i6AD9ErSdNo98cyoKw6Euxj8K'

function stateWith(operators: Wallet[]): { state: State; action: ActionRec } {
  const action: ActionRec = {
    id: 'act1',
    kind: 'xrpl.payment',
    account: 'lock',
    tx: { TransactionType: 'Payment', Account: LOCK, Destination: ALICE, Amount: '1000000', Fee: '1000', Sequence: 10, LastLedgerSequence: 500 },
    status: 'pending',
    reason: { kind: 'release', transferId: 't1' },
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    sequence: 10,
  }
  const state = { config: genesis.config as State['config'], tokens: {}, transfers: {}, operators: {}, actions: { act1: action }, evmActions: {}, accounts: {}, cursor: structuredClone(genesis.cursor), unmatched: [], treasuryXrp: '0', fees: { xrp: '0', xrpByToken: {}, paidXrp: '0', owed: {}, payouts: [] } } as State
  operators.forEach((w, i) => (state.operators[`ed${i}`] = { node: `ed${i}`, xrplAddress: w.classicAddress, xrplPublicKey: w.publicKey, evmAddress: '0x' + String(i).padStart(40, '0') }))
  return { state, action }
}

function signerEntry(w: Wallet, tx: Record<string, unknown>): SignerEntry {
  const signed = w.sign({ ...(tx as any), SigningPubKey: '' }, true)
  return (decode(signed.tx_blob) as { Signers: SignerEntry[] }).Signers[0]
}

describe('ingestSignatures', () => {
  it('takes an operator signature made with the operator key', () => {
    const a = Wallet.generate()
    const { state, action } = stateWith([a, Wallet.generate()])
    const cache = {}
    expect(ingestSignatures(state, cache, [{ node: 'ed0', sig: { a: action.id, s: signerEntry(a, action.tx) } }])).toBe(1)
  })
  it('refuses a signature that verifies under a key that is not the operator key', () => {
    const a = Wallet.generate()
    const attacker = Wallet.generate()
    const { state, action } = stateWith([a, Wallet.generate()])
    // a valid signature over the multisign payload for a's account, made with the attacker's key and presented as a's
    const signingData = encodeForMultisigning({ ...(action.tx as any), SigningPubKey: '' }, a.classicAddress)
    const forged: SignerEntry = { Signer: { Account: a.classicAddress, SigningPubKey: attacker.publicKey, TxnSignature: signRaw(signingData, attacker.privateKey) } }
    const cache: Record<string, { signers: Record<string, SignerEntry> }> = {}
    expect(ingestSignatures(state, cache, [{ node: 'ed1', sig: { a: action.id, s: forged } }])).toBe(0)
    expect(cache[action.id].signers[a.classicAddress]).toBeUndefined()
    // the real one still gets in afterwards
    expect(ingestSignatures(state, cache, [{ node: 'ed0', sig: { a: action.id, s: signerEntry(a, action.tx) } }])).toBe(1)
  })
  it('ignores signatures from accounts outside the operator set', () => {
    const { state, action } = stateWith([Wallet.generate(), Wallet.generate()])
    const outsider = Wallet.generate()
    expect(ingestSignatures(state, {}, [{ node: 'edZ', sig: { a: action.id, s: signerEntry(outsider, action.tx) } }])).toBe(0)
  })
})

describe('assemble', () => {
  it('orders Signers by numeric AccountID, which base58 order is not', () => {
    // find two wallets whose base58 order and AccountID order disagree
    let a = Wallet.generate()
    let b = Wallet.generate()
    for (let i = 0; i < 200; i++) {
      const base58 = a.classicAddress < b.classicAddress ? -1 : 1
      const numeric = Buffer.compare(decodeAccountID(a.classicAddress), decodeAccountID(b.classicAddress))
      if (base58 !== numeric) break
      b = Wallet.generate()
    }
    const { action } = stateWith([a, b])
    const entry = { signers: { [a.classicAddress]: signerEntry(a, action.tx), [b.classicAddress]: signerEntry(b, action.tx) } }
    const tx = assemble(action, entry, 2)!
    const accounts = (tx.Signers as SignerEntry[]).map((s) => s.Signer.Account)
    const numeric = [a.classicAddress, b.classicAddress].sort((x, y) => Buffer.compare(decodeAccountID(x), decodeAccountID(y)))
    expect(accounts).toEqual(numeric)
    expect(assemble(action, { signers: { [a.classicAddress]: entry.signers[a.classicAddress] } }, 2)).toBeNull()
  })
})
