import fs from 'node:fs'
import path from 'node:path'
import { concat, decodeErrorResult, encodeAbiParameters, encodePacked, hashTypedData, keccak256, toFunctionSelector, toHex, type Abi, type AbiParameter, type Address, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { MAX_BURN_FEE, MINTER_ABI, TOKEN_ABI, UNCAPPED, domain, resumeTyped, setBurnFeeTyped, sweepTyped } from '../src/evm'
import type { EvmConfig } from '../src/types'

const MINTER = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const CFG: EvmConfig = { rpc: ['http://127.0.0.1:1'], chainId: 1449000, minter: MINTER, windowBlocks: 10, confirmations: 2, maxEventsPerView: 50, pollMs: 8000, gasLimit: 1500000, relayTimeoutMs: 180000 }
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const BOB = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address

const typehash = (sig: string) => keccak256(toHex(sig))
const word = (types: string, values: unknown[]) => encodeAbiParameters(types.split(',').map((type) => ({ type }) as AbiParameter), values)

/** The digest the way the contract builds it (ThresholdMinter._hashTypedData), from the typehash strings in the spec: no viem typed-data code involved. */
function contractDigest(structHash: Hex): Hex {
  const separator = keccak256(
    word('bytes32,bytes32,bytes32,uint256,address', [typehash('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), typehash('BlumeBridge'), typehash('3'), BigInt(CFG.chainId), MINTER]),
  )
  return keccak256(concat(['0x1901', separator, structHash]))
}

describe('the minter v3 domain and messages', () => {
  it('signs for BlumeBridge version 3 on the configured chain and minter', () => {
    expect(domain(CFG)).toEqual({ name: 'BlumeBridge', version: '3', chainId: 1449000, verifyingContract: MINTER })
  })

  it('SetBurnFee hashes to what the contract computes', () => {
    const structHash = keccak256(word('bytes32,uint256,uint256', [typehash('SetBurnFee(uint256 burnFee,uint256 nonce)'), 250000000000000000n, 7n]))
    expect(hashTypedData(setBurnFeeTyped(CFG, 250000000000000000n, 7n))).toBe(contractDigest(structHash))
  })

  it('Resume hashes to what the contract computes', () => {
    const structHash = keccak256(word('bytes32,uint256', [typehash('Resume(uint256 nonce)'), 3n]))
    expect(hashTypedData(resumeTyped(CFG, 3n))).toBe(contractDigest(structHash))
  })

  it('Sweep hashes its arrays the way the contract does: keccak of the packed array, each element padded to 32 bytes', () => {
    const to = [ALICE, BOB]
    const amounts = [10n ** 18n, 5n * 10n ** 17n]
    const structHash = keccak256(
      word('bytes32,bytes32,bytes32,uint256', [typehash('Sweep(address[] to,uint256[] amounts,uint256 nonce)'), keccak256(encodePacked(['address[]'], [to])), keccak256(encodePacked(['uint256[]'], [amounts])), 2n]),
    )
    expect(hashTypedData(sweepTyped(CFG, to, amounts, 2n))).toBe(contractDigest(structHash))
  })

  it('a message made for another minter, chain or nonce is a different digest', () => {
    const base = hashTypedData(resumeTyped(CFG, 0n))
    expect(hashTypedData(resumeTyped({ ...CFG, minter: ALICE }, 0n))).not.toBe(base)
    expect(hashTypedData(resumeTyped({ ...CFG, chainId: 1440000 }, 0n))).not.toBe(base)
    expect(hashTypedData(resumeTyped(CFG, 1n))).not.toBe(base)
  })

  it('knows the two special caps and the fee ceiling', () => {
    expect(UNCAPPED).toBe((1n << 256n) - 1n)
    expect(MAX_BURN_FEE).toBe(10n ** 18n)
  })
})

describe('the ABIs', () => {
  const minterErrors = ['BadSignerSet', 'NotEnoughSignatures', 'BadSignature', 'SignersNotSorted', 'UnknownToken', 'TokenExists', 'AlreadyMinted', 'CapExceeded', 'BadNonce', 'BadMetadata', 'BadFee', 'NotToken', 'BadSweep', 'SweepFailed', 'IsPaused', 'AlreadyPaused', 'NotPaused', 'NotSigner']
  const tokenErrors = ['BadFeePayment', 'FeeTransferFailed', 'BadAddress', 'BadAmount', 'NotMinter']

  it.each(minterErrors)('decodes the minter revert %s by name', (name) => {
    expect(decodeErrorResult({ abi: MINTER_ABI, data: toFunctionSelector(`${name}()`) }).errorName).toBe(name)
  })
  it.each(tokenErrors)('decodes the token revert %s by name', (name) => {
    expect(decodeErrorResult({ abi: TOKEN_ABI, data: toFunctionSelector(`${name}()`) }).errorName).toBe(name)
  })

  // The compiled contracts are the truth: every item the cluster declares must be the contract's own, name, argument types and mutability.
  // Needs `forge build` in contracts/; without it the check is skipped, not failed.
  const out = (file: string, name: string) => path.join(__dirname, '..', '..', 'contracts', 'out', file, `${name}.json`)
  const signature = (i: { name: string; inputs?: readonly AbiParameter[] }) => `${i.name}(${(i.inputs ?? []).map(canonical).join(',')})`
  function canonical(p: AbiParameter): string {
    return p.type.startsWith('tuple') ? `(${((p as AbiParameter & { components: AbiParameter[] }).components ?? []).map(canonical).join(',')})${p.type.slice(5)}` : p.type
  }
  function matchesArtifact(ours: Abi, artifact: Abi) {
    for (const item of ours) {
      if (item.type !== 'function' && item.type !== 'event' && item.type !== 'error') continue
      const theirs = (artifact as readonly any[]).find((a) => a.type === item.type && a.name === item.name)
      expect(theirs, `${item.type} ${item.name} is not in the compiled contract`).toBeTruthy()
      expect(signature(item), `${item.type} ${item.name}`).toBe(signature(theirs))
      if (item.type === 'function') {
        expect(item.stateMutability, `${item.name} mutability`).toBe(theirs.stateMutability)
        expect((item.outputs ?? []).map(canonical), `${item.name} outputs`).toEqual((theirs.outputs ?? []).map(canonical))
      }
    }
  }
  const minterArtifact = out('ThresholdMinter.sol', 'ThresholdMinter')
  const tokenArtifact = out('BridgeToken.sol', 'BridgeToken')
  it.skipIf(!fs.existsSync(minterArtifact))('every minter function, event and error is the compiled contract\'s', () => {
    matchesArtifact(MINTER_ABI, JSON.parse(fs.readFileSync(minterArtifact, 'utf8')).abi)
  })
  it.skipIf(!fs.existsSync(tokenArtifact))('every token function, event and error is the compiled contract\'s', () => {
    matchesArtifact(TOKEN_ABI, JSON.parse(fs.readFileSync(tokenArtifact, 'utf8')).abi)
  })
})
