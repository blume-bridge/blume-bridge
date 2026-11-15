/**
 * Read-only JSON-RPC against the public endpoints, with a timeout and a list to fall back through. Shared by the watchdog
 * and reconcile-snapshot.ts. Nothing here signs or submits anything.
 */

/** A rippled-style JSON-RPC call (api_version 2): the first endpoint that answers wins. An account or object that does not exist ends the search, since every server would say the same. */
export async function xrplRpc(urls: string[], method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const errors: string[] = []
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [{ api_version: 2, ...params }] }), signal: AbortSignal.timeout(timeoutMs) })
      const body = (await res.json()) as { result?: any }
      if (!body.result || body.result.status === 'error') throw new Error(body.result?.error ?? 'empty result')
      return body.result
    } catch (e) {
      const m = (e as Error).message
      errors.push(`${new URL(url).host}: ${m}`)
      if (/actNotFound|entryNotFound|objectNotFound|ammNotFound/.test(m)) break
    }
  }
  throw new Error(errors.join('; '))
}

/** An Ethereum JSON-RPC 2.0 call, the first endpoint that answers wins. */
export async function evmRpc(urls: string[], method: string, params: unknown[], timeoutMs: number): Promise<any> {
  const errors: string[] = []
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) })
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } }
      if (body.error) throw new Error(body.error.message ?? 'rpc error')
      return body.result
    } catch (e) {
      errors.push(`${new URL(url).host}: ${(e as Error).message}`)
    }
  }
  throw new Error(errors.join('; '))
}
