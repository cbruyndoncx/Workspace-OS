import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ConnectorSettings, normalizeServerUrl } from './connector-settings'

describe('normalizeServerUrl', () => {
  it('accepts https anywhere and plain http only on this computer', () => {
    expect(normalizeServerUrl('https://bob.example/mcp')).toEqual({ ok: true, url: 'https://bob.example/mcp' })
    expect(normalizeServerUrl(' http://127.0.0.1:3939/mcp ')).toEqual({ ok: true, url: 'http://127.0.0.1:3939/mcp' })
    expect(normalizeServerUrl('http://localhost:3939/mcp').ok).toBe(true)
    expect(normalizeServerUrl('http://bob.example/mcp').ok).toBe(false)
  })

  it('refuses credentials in the address, other schemes, and non-addresses', () => {
    expect(normalizeServerUrl('https://me:pw@bob.example/mcp').ok).toBe(false)
    expect(normalizeServerUrl('file:///etc/passwd').ok).toBe(false)
    expect(normalizeServerUrl('bob.example/mcp').ok).toBe(false)
    expect(normalizeServerUrl('').ok).toBe(false)
    expect(normalizeServerUrl(42).ok).toBe(false)
  })

  it('drops a fragment', () => {
    expect(normalizeServerUrl('https://bob.example/mcp#x')).toEqual({ ok: true, url: 'https://bob.example/mcp' })
  })
})

describe('ConnectorSettings', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-connset-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('stores an address with its sign-in kind; chat scripts start off', () => {
    const s = new ConnectorSettings(dir)
    expect(s.get('bob_skills')).toBeUndefined()
    s.setEndpoint('bob_skills', 'http://127.0.0.1:3939/mcp', 'none')
    expect(new ConnectorSettings(dir).get('bob_skills')).toEqual({ url: 'http://127.0.0.1:3939/mcp', auth: 'none', chatScripts: false })
  })

  it('keeps the chat-scripts switch for the same address, resets it for a new one', () => {
    const s = new ConnectorSettings(dir)
    s.setEndpoint('bob_skills', 'https://bob.example/mcp', 'oauth')
    s.setChatScripts('bob_skills', true)
    s.setEndpoint('bob_skills', 'https://bob.example/mcp', 'oauth')
    expect(s.get('bob_skills')?.chatScripts).toBe(true)
    s.setEndpoint('bob_skills', 'http://127.0.0.1:3939/mcp', 'none')
    expect(s.get('bob_skills')?.chatScripts).toBe(false)
  })

  it('ignores connectors without an address, bad addresses, and a switch before connecting', () => {
    const s = new ConnectorSettings(dir)
    s.setEndpoint('github', 'https://api.github.com', 'none')
    s.setEndpoint('bob_skills', 'http://bob.example/mcp', 'none')
    s.setChatScripts('bob_skills', true)
    expect(s.get('github')).toBeUndefined()
    expect(s.get('bob_skills')).toBeUndefined()
  })

  it('remove forgets the address; a tampered file reads as nothing', () => {
    const s = new ConnectorSettings(dir)
    s.setEndpoint('bob_skills', 'https://bob.example/mcp', 'none')
    s.remove('bob_skills')
    expect(s.get('bob_skills')).toBeUndefined()
    fs.writeFileSync(path.join(dir, 'mcp-connector-settings.json'), JSON.stringify({ bob_skills: { url: 'http://evil.example/mcp', auth: 'none', chatScripts: true } }))
    expect(s.get('bob_skills')).toBeUndefined()
    expect(s.resolver()('bob_skills')).toBeUndefined()
  })
})
