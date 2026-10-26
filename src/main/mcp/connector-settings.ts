import fs from 'fs'
import path from 'path'
import { getConnector, isRemoteUrl } from './connectors'

/**
 * Per-connector settings for 'remote-url' connectors: the server address the
 * person chose, whether that server needed a sign-in when it was connected,
 * and whether chats may run the scripts its skills bundle. No secret lives
 * here — a sign-in's tokens stay in the vault (oauth/remote-vault.ts).
 */
const SETTINGS_FILE = 'mcp-connector-settings.json'

export type EndpointAuth = 'none' | 'oauth'

export interface ConnectorEndpoint {
  url: string
  auth: EndpointAuth
  /** Chats may run `uv run` for this server's skill scripts (off unless switched on). */
  chatScripts: boolean
}

/** Resolves a remote-url connector's endpoint; undefined until it is connected. */
export type EndpointResolver = (connectorId: string) => ConnectorEndpoint | undefined

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * The server address as stored: https anywhere, plain http only on this
 * computer (a skills server on 127.0.0.1), and no user name or password in it.
 */
export function normalizeServerUrl(input: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Enter the server address.' }
  if (input.length > 2048) return { ok: false, error: 'That address is too long.' }
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return { ok: false, error: 'That is not a web address.' }
  }
  if (u.username || u.password) return { ok: false, error: 'Leave the user name and password out of the address.' }
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) {
    return { ok: false, error: 'Use https for a server on another computer; plain http only works for one on this computer.' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'The address must start with https:// or http://.' }
  u.hash = ''
  return { ok: true, url: u.toString() }
}

function isEndpoint(v: unknown): v is ConnectorEndpoint {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return typeof e.url === 'string' && normalizeServerUrl(e.url).ok && (e.auth === 'none' || e.auth === 'oauth') && typeof e.chatScripts === 'boolean'
}

export class ConnectorSettings {
  constructor(private readonly storeDir: string) {}

  private filePath(): string {
    return path.join(this.storeDir, SETTINGS_FILE)
  }

  private read(): Record<string, ConnectorEndpoint> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath(), 'utf-8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, ConnectorEndpoint> = {}
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        const c = getConnector(id)
        if (c && isRemoteUrl(c) && isEndpoint(v)) out[id] = { url: v.url, auth: v.auth, chatScripts: v.chatScripts }
      }
      return out
    } catch {
      return {}
    }
  }

  private write(all: Record<string, ConnectorEndpoint>): void {
    fs.mkdirSync(this.storeDir, { recursive: true })
    fs.writeFileSync(this.filePath(), JSON.stringify(all, null, 2), { encoding: 'utf-8', mode: 0o600 })
  }

  get(id: string): ConnectorEndpoint | undefined {
    return this.read()[id]
  }

  /** Records a connected server. The chat-scripts switch survives a reconnect to the same address. */
  setEndpoint(id: string, url: string, auth: EndpointAuth): void {
    const c = getConnector(id)
    const norm = normalizeServerUrl(url)
    if (!c || !isRemoteUrl(c) || !norm.ok) return
    const all = this.read()
    const prev = all[id]
    all[id] = { url: norm.url, auth, chatScripts: prev?.url === norm.url ? prev.chatScripts : false }
    this.write(all)
  }

  setChatScripts(id: string, on: boolean): void {
    const all = this.read()
    const c = getConnector(id)
    if (!all[id] || !c?.chatScripts) return
    all[id] = { ...all[id], chatScripts: on }
    this.write(all)
  }

  remove(id: string): void {
    const all = this.read()
    if (!(id in all)) return
    delete all[id]
    this.write(all)
  }

  resolver(): EndpointResolver {
    const all = this.read()
    return (id) => all[id]
  }
}
