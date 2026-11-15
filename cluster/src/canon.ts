import { createHash } from 'node:crypto'

/**
 * Canonical JSON: keys sorted at every level, no whitespace. Every node must
 * write byte-identical state files or HotPocket sees divergent state hashes,
 * so all consensus writes go through this.
 */
export function canon(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortKeys(v)
    }
    return out
  }
  return value
}

/**
 * Code-point string order. Consensus code sorts with this, never with
 * localeCompare: that one follows the host's locale and ICU build, and a
 * node that sorts differently proposes a different view.
 */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Content hash of any value, over its canonical JSON. */
export function hashOf(value: unknown): string {
  return sha256(canon(value))
}

/** A short deterministic id from any material. 16 hex chars. */
export function shortId(...parts: (string | number)[]): string {
  return sha256(parts.join('|')).slice(0, 16)
}

/** A record's own entry for a key a user supplied: `__proto__`, `constructor` and the rest of Object.prototype are not entries. */
export function own<T>(rec: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined
}

/** A request is a plain JSON object. `null`, arrays and primitives parse fine and then fail on the first property read. */
export function isRequest(msg: unknown): msg is Record<string, any> {
  return typeof msg === 'object' && msg !== null && !Array.isArray(msg)
}
