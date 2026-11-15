import fs from 'node:fs'

/**
 * Node-local log, outside consensus. /tmp is the container's own filesystem:
 * never hashed, survives between rounds, gone with the instance.
 */
const LOG_PATH = '/tmp/bridge-cluster.log'
const MAX_BYTES = 2 * 1024 * 1024

export function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}\n`
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_BYTES) fs.truncateSync(LOG_PATH, 0)
    fs.appendFileSync(LOG_PATH, stamped)
  } catch {
    /* logging must never break a round */
  }
  console.log(stamped.trimEnd())
}
