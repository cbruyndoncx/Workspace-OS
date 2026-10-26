import { getConnector, isRemoteUrl } from './connectors'
import type { EndpointResolver } from './connector-settings'
import { probeMcpServer, type OAuthFetch } from './oauth/remote-oauth'

/**
 * Waking a skills server before it is needed. A server on a host that sleeps
 * when idle (Render's free plan, for one) answers its first request only after
 * it has started again, which can take a minute or more. Claude Code gives an
 * MCP server a limited time to connect at the start of a run, so a sleeping
 * server would be missing from that run; asking it first wakes it up.
 *
 * The probe is an MCP `initialize` (oauth/remote-oauth.ts): any answer, a 401
 * included, means the server is up. No sign-in or token is involved.
 */

/** How long a run waits for a sleeping server before it starts anyway. */
export const WARMUP_TIMEOUT_MS = 90_000
/** Claude Code's MCP connect time for runs with a server-address connector. */
export const MCP_CONNECT_TIMEOUT_MS = 90_000
/** After this long the run says it is waking the server. */
export const WARMUP_NOTICE_AFTER_MS = 3_000

/** A fetch that gives up after `ms` (an AbortSignal timeout; the probe reports it as such). */
export function fetchWithTimeout(ms: number): OAuthFetch {
  return (url, init) => fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(ms) })
}

/** The wired-in connectors that point at a server address, with that address. */
export function addressServers(ids: string[], endpoints: EndpointResolver): { id: string; name: string; url: string }[] {
  const out: { id: string; name: string; url: string }[] = []
  for (const id of ids) {
    const c = getConnector(id)
    const ep = c && isRemoteUrl(c) ? endpoints(id) : undefined
    if (c && ep) out.push({ id, name: c.displayName, url: ep.url })
  }
  return out
}

export interface WarmUpResult {
  id: string
  name: string
  ok: boolean
  ms: number
  error?: string
}

/**
 * Probes each server, all at once, and resolves when every one answered or
 * gave up. `onSlow` runs once per server still waiting after `noticeAfterMs`.
 */
export async function warmUp(
  servers: { id: string; name: string; url: string }[],
  fetchFn: OAuthFetch,
  opts: { noticeAfterMs?: number; onSlow?: (name: string) => void; now?: () => number } = {},
): Promise<WarmUpResult[]> {
  const now = opts.now ?? Date.now
  return Promise.all(
    servers.map(async (s) => {
      const t0 = now()
      const notice = opts.onSlow ? setTimeout(() => opts.onSlow?.(s.name), opts.noticeAfterMs ?? WARMUP_NOTICE_AFTER_MS) : null
      try {
        const r = await probeMcpServer(s.url, fetchFn)
        return { id: s.id, name: s.name, ok: r.ok, ms: now() - t0, ...(r.ok ? {} : { error: r.error }) }
      } finally {
        if (notice) clearTimeout(notice)
      }
    }),
  )
}
