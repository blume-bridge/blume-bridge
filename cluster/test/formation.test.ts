import { describe, expect, it } from 'vitest'
import { describeSamples, formationProblems, type HpStatus, type NodeSample } from '../scripts/lib/formation'

/**
 * Has a new cluster formed? The second rehearsal of 2026-10-18 had every instance on the app and a cluster that had stopped at
 * ledger 133 with one node at 132 and every node `unreliable`; the creation script said "cluster created" (Decision 39).
 */
const APP = 'a'.repeat(64)
const UNL = ['edk1', 'edk2', 'edk3']
const status = (ledgerSeqNo: number, over: Partial<HpStatus> = {}): HpStatus => ({ ledgerSeqNo, voteStatus: 'synced', currentUnl: UNL, peers: ['p1', 'p2'], ...over })
const node = (name: string, st: HpStatus | null, code: NodeSample['code'] = { loaded: 'app', appHash: APP }): NodeSample => ({ node: name, code, status: st })
const opts = { appHash: APP, unl: 3, gapMs: 10_000 }
const A = 'ashburn.example:26201'
const B = 'hosttwo.example:26422'
const C = 'hostthree.example:26203'

describe('formationProblems', () => {
  it('accepts a cluster whose nodes are synced, on the app, with the whole UNL, and whose ledgers move', () => {
    const first = [node(A, status(100)), node(B, status(100)), node(C, status(101))]
    const second = [node(A, status(103)), node(B, status(103)), node(C, status(104))]
    expect(formationProblems(first, second, opts)).toEqual([])
  })

  it('rejects the cluster that stalled on 2026-10-18: ledgers 133, 132 and 133, every node unreliable, none moving', () => {
    const stuck = () => [node(A, status(133, { voteStatus: 'unreliable' })), node(B, status(132, { voteStatus: 'unreliable', peers: ['p1'] })), node(C, status(133, { voteStatus: 'unreliable' }))]
    const problems = formationProblems(stuck(), stuck(), opts)
    for (const n of [A, B, C]) {
      expect(problems).toContain(`${n}: unreliable, not synced`)
      expect(problems).toContain(`${n}: ledger ${n === B ? 132 : 133} to ${n === B ? 132 : 133} in 10 s: it is not closing ledgers`)
    }
  })

  it('rejects a node that is left behind while the others move', () => {
    const first = [node(A, status(100)), node(B, status(100)), node(C, status(100))]
    const second = [node(A, status(110)), node(B, status(110)), node(C, status(100))]
    const problems = formationProblems(first, second, opts)
    expect(problems.join('\n')).toMatch(new RegExp(`${C}: ledger 100 to 100`))
    expect(problems.join('\n')).toMatch(/the nodes are at different ledgers: .* hostthree\.example:26203 100/)
  })

  it('rejects a node whose UNL is not the whole cluster yet: the bundle has not reached it', () => {
    const first = [node(A, status(10)), node(B, status(10)), node(C, status(10))]
    const second = [node(A, status(13)), node(B, status(13)), node(C, status(13, { currentUnl: ['edk1'] }))]
    expect(formationProblems(first, second, opts)).toEqual([`${C}: its UNL has 1 key(s), not 3: the bundle's configuration has not reached it`])
  })

  it('rejects a node that cannot be read, or gives no status, or runs something else', () => {
    const first = [node(A, status(10)), node(B, status(10)), node(C, status(10))]
    const second = [node(A, status(13)), { node: B, code: null, status: null }, node(C, null)]
    expect(formationProblems(first, second, opts)).toEqual([`${B}: cannot be read`, `${C}: gives no HotPocket status`])
    const other = [node(A, status(13), { loaded: 'prev', appHash: APP }), node(B, status(13), { loaded: 'app', appHash: 'b'.repeat(64) }), node(C, status(13))]
    const problems = formationProblems(first, other, opts)
    expect(problems).toContain(`${A}: runs prev, not the app`)
    expect(problems.some((p) => p.startsWith(`${B}: runs app bbbbbbbbbbbb, not the one that was built (aaaaaaaaaaaa)`))).toBe(true)
  })

  it('does not call a node that has no first look broken for not having moved: the next look will tell', () => {
    const first = [node(A, null), node(B, status(10)), node(C, status(10))]
    const second = [node(A, status(13)), node(B, status(13)), node(C, status(13))]
    expect(formationProblems(first, second, opts)).toEqual([])
  })

  it('wants ledgers to move in proportion to the time between the looks, and accepts a ledger every six seconds', () => {
    const first = [node(A, status(100)), node(B, status(100)), node(C, status(100))]
    const slow = [node(A, status(101)), node(B, status(101)), node(C, status(101))]
    expect(formationProblems(first, slow, opts)).toEqual([]) // one ledger in ten seconds: the pace of the first rehearsal's cluster
    expect(formationProblems(first, slow, { ...opts, gapMs: 30_000 })).toHaveLength(3) // but not one in thirty
  })

  it('refuses looks at different nodes', () => {
    expect(() => formationProblems([node(A, status(1))], [node(A, status(1)), node(B, status(1))], opts)).toThrow(/same nodes/)
  })
})

describe('describeSamples', () => {
  it('says ledger, vote, UNL, peers and code of every node, and when a node gives no status', () => {
    const text = describeSamples([node(A, status(133, { voteStatus: 'unreliable' })), node(B, null)])
    expect(text).toContain('ledger 133')
    expect(text).toContain('unreliable')
    expect(text).toContain('unl 3  peers 2  app aaaaaaaaaaaa')
    expect(text).toMatch(/hosttwo\.example:26422 +no status/)
  })
})
