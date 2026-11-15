import { describe, expect, it } from 'vitest'
import { encodeForMultisigning } from 'ripple-binary-codec'
import { decodeAccountID } from 'ripple-address-codec'
import { verify } from 'ripple-keypairs'
import { Wallet, decode } from 'xrpl'
import type { NodeKeys } from '../src/keys'
import { batchTx } from '../src/machine'
import { assemble, ingestSignatures, mySignatures } from '../src/signing'
import type { ActionRec, SignerEntry, State } from '../src/types'
import genesis from '../genesis/dev.json'

const FUND = genesis.config.xrpl.fundingAccount
const ALICE = 'rJfqVsXN3i6AD9ErSdNo98cyoKw6Euxj8K'
const BOB = 'rpXzhnkZN2JArdmWAk3tmrtJwsErv963Na'
const INDEPENDENT = 524288
const INNER_FLAG = 1073741824

/** A pending batch the way promoteActions leaves it: outer at 20, inners at 21 and 22, expiry on the outer only. */
function stateWith(operators: Wallet[]): { state: State; action: ActionRec } {
  const built = batchTx(FUND, [{ TransactionType: 'Payment', Destination: ALICE, Amount: '1000000' }, { TransactionType: 'Payment', Destination: BOB, Amount: '2000000' }], INDEPENDENT) as any
  const action: ActionRec = {
    id: 'batch1',
    kind: 'xrpl.batch',
    account: 'funding',
    tx: { ...built, Account: FUND, Fee: '1000', Sequence: 20, LastLedgerSequence: 500, RawTransactions: built.RawTransactions.map((r: any, i: number) => ({ RawTransaction: { ...r.RawTransaction, Sequence: 21 + i } })) },
    status: 'pending',
    reason: { kind: 'payout', at: 0 },
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    sequence: 20,
    lastLedger: 500,
    inner: [{ sequence: 21 }, { sequence: 22 }],
  }
  const state = { config: genesis.config as State['config'], tokens: {}, transfers: {}, operators: {}, actions: { batch1: action }, evmActions: {}, accounts: {}, cursor: structuredClone(genesis.cursor), unmatched: [], treasuryXrp: '0', fees: { xrp: '0', xrpByToken: {}, paidXrp: '0', owed: {}, payouts: [] } } as State
  operators.forEach((w, i) => (state.operators[`ed${i}`] = { node: `ed${i}`, xrplAddress: w.classicAddress, xrplPublicKey: w.publicKey, evmAddress: '0x' + String(i).padStart(40, '0') }))
  return { state, action }
}

const keysOf = (w: Wallet): NodeKeys => ({ xrpl: { address: w.classicAddress, seed: w.seed!, publicKey: w.publicKey }, evm: { address: '0x' + '0'.repeat(40), privateKey: '0x' + '1'.repeat(64) }, createdAt: 0 })

describe('multisigning an outer Batch', () => {
  it('goes through mySignatures, ingestSignatures and assemble like any transaction, and every signature verifies', () => {
    const [a, b, c] = [Wallet.generate(), Wallet.generate(), Wallet.generate()]
    const { state, action } = stateWith([a, b, c])
    // each operator signs on its own node
    const caches = [a, b].map(() => ({}) as Record<string, { signers: Record<string, SignerEntry> }>)
    const sigA = mySignatures(state, keysOf(a), caches[0])
    const sigB = mySignatures(state, keysOf(b), caches[1])
    expect(sigA).toHaveLength(1)
    expect(sigB).toHaveLength(1)
    expect(sigA[0].s.Signer.Account).toBe(a.classicAddress)
    // signing again is idempotent
    expect(mySignatures(state, keysOf(a), caches[0])[0].s).toEqual(sigA[0].s)
    // a third node takes both in over NPL
    const cache: Record<string, { signers: Record<string, SignerEntry> }> = {}
    expect(ingestSignatures(state, cache, [{ node: 'ed0', sig: sigA[0] }, { node: 'ed1', sig: sigB[0] }])).toBe(2)
    const tx = assemble(action, cache[action.id], state.config.k) as any
    expect(tx).not.toBeNull()
    expect(tx.SigningPubKey).toBe('')
    expect(tx.TransactionType).toBe('Batch')
    expect(tx.Flags).toBe(INDEPENDENT)
    expect(tx.BatchSigners).toBeUndefined()
    // Signers in numeric AccountID order, as assemble sorts
    const signers = (tx.Signers as SignerEntry[]).map((s) => s.Signer.Account)
    expect(signers).toHaveLength(2)
    expect(signers).toEqual([a.classicAddress, b.classicAddress].sort((x, y) => Buffer.compare(decodeAccountID(x), decodeAccountID(y))))
    // the inners rode through the signing untouched
    expect(tx.RawTransactions).toHaveLength(2)
    tx.RawTransactions.forEach((r: any, i: number) => {
      expect(r.RawTransaction).toMatchObject({ TransactionType: 'Payment', Account: FUND, Fee: '0', SigningPubKey: '', Flags: INNER_FLAG, Sequence: 21 + i })
      expect('LastLedgerSequence' in r.RawTransaction).toBe(false)
      expect('TxnSignature' in r.RawTransaction).toBe(false)
    })
    expect(tx.RawTransactions[0].RawTransaction.Destination).toBe(ALICE)
    expect(tx.RawTransactions[1].RawTransaction.Destination).toBe(BOB)
    // each signature is over the assembled outer without Signers, for its own account
    const { Signers, ...unsigned } = tx
    for (const { Signer } of Signers as SignerEntry[]) {
      const data = encodeForMultisigning(unsigned, Signer.Account)
      expect(verify(data, Signer.TxnSignature, Signer.SigningPubKey)).toBe(true)
    }
    // and the blob round-trips with the inners intact
    const signed = a.sign({ ...(action.tx as any), SigningPubKey: '' }, true)
    const decoded = decode(signed.tx_blob) as any
    expect(decoded.RawTransactions).toHaveLength(2)
    expect(decoded.RawTransactions[1].RawTransaction.Sequence).toBe(22)
  })
  it('refuses a signature over the batch made with a key that is not the operator key', () => {
    const [a, b] = [Wallet.generate(), Wallet.generate()]
    const { state, action } = stateWith([a, b])
    const attacker = Wallet.generate()
    const forged = attacker.sign({ ...(action.tx as any), SigningPubKey: '' }, true)
    const entry = (decode(forged.tx_blob) as any).Signers[0] as SignerEntry
    entry.Signer.Account = a.classicAddress
    expect(ingestSignatures(state, {}, [{ node: 'ed0', sig: { a: action.id, s: entry } }])).toBe(0)
  })
  it('no wallet signs an inner on its own', () => {
    const w = Wallet.generate()
    const inner = { TransactionType: 'Payment', Account: w.classicAddress, Destination: ALICE, Amount: '1', Fee: '0', SigningPubKey: '', Flags: INNER_FLAG, Sequence: 21 }
    expect(() => w.sign(inner as any)).toThrow(/inner/i)
    expect(() => w.sign(inner as any, true)).toThrow(/inner/i)
  })
})
