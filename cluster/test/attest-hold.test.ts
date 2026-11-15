import { describe, expect, it } from 'vitest'
import { heldByOperator } from '../src/attest'
import { queueEvmAction } from '../src/machine'
import type { EvmActionRec, State } from '../src/types'
import { NOW, evmState } from './helpers'

function withMint(dir: 'in' | 'out'): { s: State; a: EvmActionRec } {
  const s = evmState()
  s.transfers.t1 = { id: 't1', dir, sym: 'PETAL', amount: '10', receive: '10', step: 3, sigs: 0, sigsNeeded: 2, from: 'rX', to: '0x1', srcTx: 'AB', done: false, createdAt: NOW, updatedAt: NOW }
  const a = queueEvmAction(s, 'mint', { tokenId: '0x1', to: '0x1', amount: '1', srcTx: '0x1' }, { kind: 'mint', transferId: 't1' }, NOW)
  return { s, a }
}

describe('what an operator pause holds back from the relayers', () => {
  it('an inbound mint waits while its token or the whole bridge is paused, and goes again after', () => {
    const { s, a } = withMint('in')
    expect(heldByOperator(s, a)).toBe(false)
    s.tokens.PETAL.opPaused = true
    expect(heldByOperator(s, a)).toBe(true)
    delete s.tokens.PETAL.opPaused
    s.paused = true
    expect(heldByOperator(s, a)).toBe(true)
    delete s.paused
    expect(heldByOperator(s, a)).toBe(false)
  })
  it('never holds a return mint: a user whose release was refused gets the tokens back whatever is paused', () => {
    const { s, a } = withMint('out')
    s.paused = true
    s.tokens.PETAL.opPaused = true
    expect(heldByOperator(s, a)).toBe(false)
  })
  it('only mints are held, not listings or metadata updates (a cap can still be lowered)', () => {
    const s = evmState()
    s.paused = true
    const list = queueEvmAction(s, 'list', { tokenId: '0x1' }, { kind: 'list', sym: 'PETAL' }, NOW)
    const update = queueEvmAction(s, 'update', { tokenId: '0x1' }, { kind: 'update', sym: 'PETAL', nonce: 1 }, NOW)
    expect(heldByOperator(s, list)).toBe(false)
    expect(heldByOperator(s, update)).toBe(false)
  })
})
