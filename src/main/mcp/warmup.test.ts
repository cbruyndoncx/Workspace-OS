import { describe, it, expect, vi } from 'vitest'
import { addressServers, warmUp } from './warmup'
import { PROBE_TIMEOUT_MESSAGE, type OAuthFetch } from './oauth/remote-oauth'

const answer = (status: number, delayMs = 0): OAuthFetch => async () => {
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) }
}

describe('addressServers', () => {
  it('lists only wired-in server-address connectors that have an address', () => {
    const ep = (id: string) => (id === 'bob_skills' ? { url: 'https://bob.example/mcp', auth: 'none' as const, chatScripts: false } : undefined)
    expect(addressServers(['github', 'bob_skills'], ep)).toEqual([{ id: 'bob_skills', name: 'BOB skills', url: 'https://bob.example/mcp' }])
    expect(addressServers(['bob_skills'], () => undefined)).toEqual([])
  })
})

describe('warmUp', () => {
  const bob = [{ id: 'bob_skills', name: 'BOB skills', url: 'https://bob.example/mcp' }]

  it('an awake server answers at once and no notice is shown', async () => {
    const onSlow = vi.fn()
    const [r] = await warmUp(bob, answer(200), { onSlow, noticeAfterMs: 50 })
    expect(r.ok).toBe(true)
    expect(onSlow).not.toHaveBeenCalled()
  })

  it('a sleeping server gets one notice while it wakes, then counts as up', async () => {
    const onSlow = vi.fn()
    const [r] = await warmUp(bob, answer(200, 120), { onSlow, noticeAfterMs: 20 })
    expect(r.ok).toBe(true)
    expect(onSlow).toHaveBeenCalledTimes(1)
    expect(onSlow).toHaveBeenCalledWith('BOB skills')
  })

  it('a 401 also means the server is awake', async () => {
    expect((await warmUp(bob, answer(401)))[0].ok).toBe(true)
  })

  it('a server that never wakes reports the timeout in words', async () => {
    const timeout: OAuthFetch = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e }
    const [r] = await warmUp(bob, timeout)
    expect(r.ok).toBe(false)
    expect(r.error).toBe(PROBE_TIMEOUT_MESSAGE)
  })
})
