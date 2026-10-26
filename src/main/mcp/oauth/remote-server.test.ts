import { describe, it, expect } from 'vitest'
import { parseAuthServerMetadata, probeMcpServer, registerClient, type OAuthFetch } from './remote-oauth'

type Call = { url: string; method: string; headers?: Record<string, string>; body?: string }

/** A fetch stub answering with a fixed status/body and recording each call. */
function answering(status: number, body: unknown = {}): { fetch: OAuthFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: OAuthFetch = async (url, init) => {
    calls.push({ url, ...init })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { fetch, calls }
}

describe('probeMcpServer', () => {
  it('an initialize that succeeds means the server needs no sign-in', async () => {
    const { fetch, calls } = answering(200)
    expect(await probeMcpServer('http://127.0.0.1:3939/mcp', fetch)).toEqual({ ok: true, value: 'open' })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers?.Accept).toContain('text/event-stream')
    expect(JSON.parse(calls[0].body ?? '{}').method).toBe('initialize')
  })

  it('a 401 means the server wants a sign-in', async () => {
    expect(await probeMcpServer('https://bob.example/mcp', answering(401).fetch)).toEqual({ ok: true, value: 'auth' })
  })

  it('a wrong path, a server error and no answer are errors to act on', async () => {
    const notFound = await probeMcpServer('https://bob.example/x', answering(404).fetch)
    expect(notFound.ok).toBe(false)
    expect(!notFound.ok && notFound.error).toContain('/mcp')
    expect((await probeMcpServer('https://bob.example/mcp', answering(502).fetch)).ok).toBe(false)
    const down: OAuthFetch = async () => { throw new Error('ECONNREFUSED') }
    expect(await probeMcpServer('http://127.0.0.1:3939/mcp', down)).toEqual({ ok: false, error: 'Could not reach the server at that address.' })
  })
})

describe('registerClient (RFC 7591)', () => {
  it('registers a public client for the loopback redirect and returns its id', async () => {
    const { fetch, calls } = answering(201, { client_id: 'abc123' })
    expect(await registerClient('https://auth.example/register', 'http://127.0.0.1:50123', fetch)).toEqual({ ok: true, value: 'abc123' })
    const sent = JSON.parse(calls[0].body ?? '{}')
    expect(sent.redirect_uris).toEqual(['http://127.0.0.1:50123'])
    expect(sent.token_endpoint_auth_method).toBe('none')
    expect(sent.grant_types).toContain('refresh_token')
  })

  it('a refusal or a reply without client_id is an error', async () => {
    expect((await registerClient('https://auth.example/register', 'http://127.0.0.1:1', answering(400, { error: 'invalid_redirect_uri' }).fetch)).ok).toBe(false)
    expect((await registerClient('https://auth.example/register', 'http://127.0.0.1:1', answering(201, {}).fetch)).ok).toBe(false)
  })
})

describe('parseAuthServerMetadata', () => {
  it('carries the registration endpoint when the server offers one', () => {
    expect(parseAuthServerMetadata({ authorization_endpoint: 'a', token_endpoint: 't', registration_endpoint: 'r' })).toEqual({ authorizationEndpoint: 'a', tokenEndpoint: 't', registrationEndpoint: 'r' })
    expect(parseAuthServerMetadata({ authorization_endpoint: 'a', token_endpoint: 't' })).toEqual({ authorizationEndpoint: 'a', tokenEndpoint: 't' })
  })
})
