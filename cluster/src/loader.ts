import HotPocket, { type HpContext } from 'hotpocket-nodejs-contract'
import { runRound } from './loader-core'

/**
 * `index.js` of the bundle: the part of the contract that never changes. All it does is hand each round to
 * src/loader-core.ts, which loads app.js (src/contract.ts) and accepts upgrades. Keep it this small.
 */

// A rejection nobody awaits (a peer-message callback, a late timer) must not end the process mid-round.
process.on('unhandledRejection', (e) => console.error(`[loader] unhandled rejection: ${(e as Error)?.message ?? String(e)}`))

// Must be an `async function`: the library awaits a callback only if its constructor is AsyncFunction, and otherwise ends the
// round (and kills the process) the moment the callback returns, with the work still in flight. A plain arrow returning a
// promise looks the same and does not work (found on the dev cluster, 2026-10-18).
async function round(ctx: HpContext): Promise<void> {
  await runRound(ctx)
}

const hpc = new HotPocket.Contract()
hpc.init(round, undefined, true)
