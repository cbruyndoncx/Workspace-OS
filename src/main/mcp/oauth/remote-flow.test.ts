import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { runRemoteOAuthFlow } from './remote-flow'
import type { OAuthFetch } from './remote-oauth'

/**
 * A server that needs a sign-in and offers dynamic client registration:
 * discovery → registration → consent (simulated by calling the loopback
 * redirect) → token exchange. Checks the registered client id is the one used.
 */
function server(): { fetch: OAuthFetch; seen: { url: string; body?: string }[] } {
  const seen: { url: string; body?: string }[] = []
  const fetch: OAuthFetch = async (url, init) => {
    seen.push({ url, body: init.body })
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v })
    if (url.endsWith('/.well-known/oauth-protected-resource')) return json({ resource: 'https://bob.example/mcp', authorization_servers: ['https://auth.example'] })
    if (url.endsWith('/.well-known/oauth-authorization-server')) return json({ authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token', registration_endpoint: 'https://auth.example/register' })
    if (url === 'https://auth.example/register') return json({ client_id: 'registered-1' })
    if (url === 'https://auth.example/token') return json({ access_token: 'at', refresh_token: 'rt', expires_in: 600 })
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { fetch, seen }
}

/** Plays the person approving consent: follow the auth URL's redirect back to the loopback. */
async function approve(authUrl: string): Promise<void> {
  const u = new URL(authUrl)
  const back = new URL(u.searchParams.get('redirect_uri') ?? '')
  back.searchParams.set('code', 'the-code')
  back.searchParams.set('state', u.searchParams.get('state') ?? '')
  await fetch(back)
}

describe('runRemoteOAuthFlow with dynamic registration', () => {
  it('registers a client when none is configured and uses it for consent and the token', async () => {
    const s = server()
    let consentClient = ''
    const res = await runRemoteOAuthFlow(
      { url: 'https://bob.example/mcp', scopes: [], dynamicRegistration: true },
      { fetchFn: s.fetch, openExternal: async (url) => { consentClient = new URL(url).searchParams.get('client_id') ?? ''; await approve(url) }, timeoutMs: 5000 },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.clientId).toBe('registered-1')
    expect(consentClient).toBe('registered-1')
    expect(res.tokens.refreshToken).toBe('rt')
    expect(new URLSearchParams(s.seen.find((c) => c.url.endsWith('/token'))?.body).get('client_id')).toBe('registered-1')
  })

  it('a configured client id skips registration', async () => {
    const s = server()
    const res = await runRemoteOAuthFlow(
      { url: 'https://bob.example/mcp', scopes: [], dynamicRegistration: true },
      { fetchFn: s.fetch, clientId: 'mine', openExternal: approve, timeoutMs: 5000 },
    )
    expect(res.ok && res.clientId).toBe('mine')
    expect(s.seen.some((c) => c.url.endsWith('/register'))).toBe(false)
  })

  it('without the registration opt-in it keeps the generic client id', async () => {
    const s = server()
    const res = await runRemoteOAuthFlow({ url: 'https://bob.example/mcp', scopes: [] }, { fetchFn: s.fetch, openExternal: approve, timeoutMs: 5000 })
    expect(res.ok && res.clientId).toBe('workspace-os')
    expect(s.seen.some((c) => c.url.endsWith('/register'))).toBe(false)
  })
})
