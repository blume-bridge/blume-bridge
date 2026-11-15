import { BaseError, HttpRequestError, NonceTooLowError, TimeoutError, createPublicClient, custom, encodeErrorResult, type Address, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { classifyRelayError, revertName } from '../src/attest'
import { MINTER_ABI } from '../src/evm'

const MINTER = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address
const ZERO32 = `0x${'00'.repeat(32)}` as Hex

/**
 * The error viem raises when the minter reverts with `name`: its own simulateContract path against a node that
 * answers the way a real one does (JSON-RPC error code 3 with the revert data), so the shape is not our guess.
 */
async function reverts(name: string): Promise<unknown> {
  const data = encodeErrorResult({ abi: MINTER_ABI, errorName: name as never })
  const client = createPublicClient({
    // retryCount 0: a plain Error from a custom provider reads to viem as an unknown RPC error and is retried; a real node's revert (code 3) is not.
    transport: custom(
      {
        request: async () => {
          throw Object.assign(new Error('execution reverted'), { code: 3, data })
        },
      },
      { retryCount: 0 },
    ),
  })
  try {
    await client.simulateContract({ address: MINTER, abi: MINTER_ABI, functionName: 'mint', args: [{ tokenId: ZERO32, to: MINTER, amount: 1n, srcTx: ZERO32 }, []], account: MINTER })
  } catch (e) {
    return e
  }
  throw new Error(`the call did not revert with ${name}`)
}

describe('revertName', () => {
  it('reads the custom error viem decoded from the ABI', async () => {
    expect(revertName(await reverts('IsPaused'))).toBe('IsPaused')
    expect(revertName(await reverts('CapExceeded'))).toBe('CapExceeded')
  })
  it('finds nothing in an error that is not a revert', () => {
    expect(revertName(new Error('boom'))).toBeUndefined()
    expect(revertName(undefined)).toBeUndefined()
    expect(revertName('IsPaused')).toBeUndefined()
  })
})

describe('classifyRelayError', () => {
  it('waits out a paused minter and a spent cap instead of calling them failures', async () => {
    expect(classifyRelayError(await reverts('IsPaused'), 'mint')).toBe('paused')
    expect(classifyRelayError(await reverts('CapExceeded'), 'mint')).toBe('cap-day')
  })

  it('takes AlreadyMinted and TokenExists as done', async () => {
    expect(classifyRelayError(await reverts('AlreadyMinted'), 'mint')).toBe('already-done')
    expect(classifyRelayError(await reverts('TokenExists'), 'list')).toBe('already-done')
  })

  it('takes BadNonce as done for an update only', async () => {
    expect(classifyRelayError(await reverts('BadNonce'), 'update')).toBe('already-done')
    expect(classifyRelayError(await reverts('BadNonce'), 'mint')).toBe('fatal')
    expect(classifyRelayError(await reverts('BadNonce'))).toBe('fatal')
  })

  it('treats a token the node has not seen yet as a node that is behind', async () => {
    expect(classifyRelayError(await reverts('UnknownToken'), 'mint')).toBe('transient')
  })

  it('leaves the rest of the minter\'s refusals fatal', async () => {
    for (const name of ['NotEnoughSignatures', 'BadMetadata', 'BadSignerSet']) expect(classifyRelayError(await reverts(name), 'mint'), name).toBe('fatal')
  })

  it('treats a refused signature as one to ask the peers for again, not as a dead end', async () => {
    for (const name of ['BadSignature', 'SignersNotSorted']) expect(classifyRelayError(await reverts(name), 'mint'), name).toBe('bad-signature')
  })

  it('calls an endpoint that refused or timed out transient, however deep the error is wrapped', () => {
    const wrap = (cause: Error) => new BaseError('The contract function "mint" failed.', { cause })
    expect(classifyRelayError(wrap(new HttpRequestError({ url: 'https://rpc.example', status: 403 })), 'mint')).toBe('transient')
    expect(classifyRelayError(wrap(new HttpRequestError({ url: 'https://rpc.example', status: 503 })), 'mint')).toBe('transient')
    expect(classifyRelayError(wrap(new TimeoutError({ body: {}, url: 'https://rpc.example' })), 'mint')).toBe('transient')
    expect(classifyRelayError(wrap(new NonceTooLowError({ nonce: 3 })), 'mint')).toBe('transient')
    expect(classifyRelayError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }), 'mint')).toBe('transient')
  })

  it('does not call what it cannot place transient', () => {
    expect(classifyRelayError(new Error('boom'), 'mint')).toBe('fatal')
    expect(classifyRelayError(undefined)).toBe('fatal')
    expect(classifyRelayError('execution reverted')).toBe('fatal')
  })
})
