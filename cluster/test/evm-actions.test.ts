import { describe, expect, it } from 'vitest'
import { applyEvmView, queueEvmAction } from '../src/machine'
import type { EvmView, State } from '../src/types'
import { NOW, evmState } from './helpers'

/** An empty agreed window `at` ms later: all it does is give the relayer rotation its turn. */
function later(s: State, ms: number): State {
  const view: EvmView = { src: 'evm', from: s.cursor.evm!.block, to: s.cursor.evm!.block + 10, events: [], listings: {} }
  return applyEvmView(s, view, NOW + ms).state
}

describe('EVM actions are waited for, not given up on', () => {
  it('keeps rotating a mint through 3n relayers and well beyond, and never fails the transfer behind it', () => {
    let s = evmState()
    s.transfers.t1 = { id: 't1', dir: 'in', sym: 'PETAL', amount: '10', receive: '10', step: 3, sigs: 0, sigsNeeded: 2, from: 'rX', to: '0x1', srcTx: 'AB', done: false, createdAt: NOW, updatedAt: NOW }
    const a = queueEvmAction(s, 'mint', { tokenId: '0x1', to: '0x1', amount: '1', srcTx: '0x1' }, { kind: 'mint', transferId: 't1' }, NOW)
    s.transfers.t1.evmActionId = a.id
    const n = Object.keys(s.operators).length
    // Far past the old limit of 3n attempts, one relayer timeout at a time.
    for (let i = 1; i <= 10 * n; i++) s = later(s, i * s.config.evm!.relayTimeoutMs)
    expect(s.evmActions[a.id].status).toBe('pending')
    expect(s.evmActions[a.id].attempts).toBeGreaterThan(3 * n)
    expect(s.transfers.t1.failed).toBeUndefined()
  })

  it('still frees the slot of a metadata update that keeps failing, so the latest metadata is sent again', () => {
    let s = evmState()
    s.tokens.PETAL.evmAddress = '0x1111111111111111111111111111111111111111'
    const a = queueEvmAction(s, 'update', { nonce: '1' }, { kind: 'update', sym: 'PETAL', nonce: 1 }, NOW)
    s.tokens.PETAL.evmUpdateActionId = a.id
    const n = Object.keys(s.operators).length
    for (let i = 1; i <= 3 * n + 1; i++) s = later(s, i * s.config.evm!.relayTimeoutMs)
    expect(s.evmActions[a.id].status).toBe('failed')
    expect(s.tokens.PETAL.evmUpdateActionId).not.toBe(a.id)
  })
})
