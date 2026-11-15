/**
 * One read request against one node, printed as JSON. Runs anywhere that can
 * reach the node's user port (on the dev box: localhost:8081..8083).
 *   node client/query.js localhost:8081 '{"type":"status"}'
 *   node client/query.js localhost:8081 '{"type":"intent.transfer",...}' --input   # consensus input
 */
import HotPocket from 'hotpocket-js-client'

HotPocket.setLogLevel(2)

async function main() {
  const [target, json, mode] = process.argv.slice(2)
  if (!target || !json) throw new Error('usage: query <host:port> <json> [--input]')
  const keys = await HotPocket.generateKeys()
  const client = await HotPocket.createClient([`wss://${target}`], keys)
  if (!(await client.connect())) throw new Error(`cannot connect to ${target}`)
  if (mode === '--input') {
    const done = new Promise((resolve) => client.on(HotPocket.events.contractOutput, (r: any) => resolve({ ledger: r.ledgerSeqNo, outputs: r.outputs })))
    const sub = await client.submitContractInput(json)
    const status = await sub.submissionStatus
    if (status.status !== 'accepted') throw new Error(`rejected: ${status.reason}`)
    console.log(JSON.stringify(await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('no output in 20s')), 20000))]), null, 2))
  } else {
    console.log(JSON.stringify(await client.submitContractReadRequest(json), null, 2))
  }
  await client.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('ERROR', e.message ?? e)
  process.exit(1)
})
