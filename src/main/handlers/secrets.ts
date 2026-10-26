import { IpcMain } from 'electron'
import { IPC } from '../ipc-channels'
import { ipcHandle } from '../ipc-registry'
import { IpcValidationError } from '../ipc-validator'
import { assertMainFrame } from '../security'
import { getVault, getConnectorState, getConnectorSettings } from '../secrets'
import { isValidSecretName } from '../secrets/vault'
import { CONNECTORS, getConnector, isConnectorId, isRemoteOAuth, isRemoteUrl, requiredSecretNames, type Connector } from '../mcp/connectors'
import { normalizeServerUrl } from '../mcp/connector-settings'
import { runRemoteOAuthFlow, type RemoteFlowDeps } from '../mcp/oauth/remote-flow'
import { remoteVaultKey, serializeRecord } from '../mcp/oauth/remote-vault'
import { probeMcpServer, type OAuthFetch } from '../mcp/oauth/remote-oauth'

/** Adapts the runtime global fetch to the narrow OAuthFetch the flow expects. */
const nodeFetch: OAuthFetch = (url, init) =>
  fetch(url, { method: init.method, headers: init.headers, body: init.body })

/**
 * Resolves the public OAuth client id for a remote connector. Env wins:
 * `MCP_OAUTH_<ID>_CLIENT_ID` (id upper-cased). Then any configured
 * `remote.clientId` in the catalog. Sentry supports Dynamic Client Registration,
 * so a fallback public id lets the flow proceed when nothing is configured.
 */
function resolveRemoteClientId(connectorId: string, configured?: string): string {
  const envKey = `MCP_OAUTH_${connectorId.toUpperCase()}_CLIENT_ID`
  const fromEnv = process.env[envKey]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  if (configured && configured.trim()) return configured.trim()
  // A stable public client id for the loopback flow (installed-app style). The
  // server may still require DCR; that surfaces as a clear auth error the user
  // can act on. Never a secret.
  return 'workspace-os'
}

/** The kind a connector reports to the renderer. */
function kindOf(c: Connector): 'stdio-apikey' | 'remote-oauth' | 'remote-url' {
  return isRemoteUrl(c) ? 'remote-url' : isRemoteOAuth(c) ? 'remote-oauth' : 'stdio-apikey'
}

/**
 * IPC surface for the secret vault + MCP connectors.
 *
 * SECURITY: no channel here ever returns a secret VALUE. `secret:list` returns
 * names only; `secret:set` takes a value and it is encrypted+persisted in main
 * immediately (never stored renderer-side). Inputs are validated/coerced at the
 * boundary — a bad name or non-string value is rejected before the vault sees it.
 */
export function registerSecretsHandlers(ipcMain: IpcMain): void {
  const vault = (): ReturnType<typeof getVault> => getVault()
  const state = (): ReturnType<typeof getConnectorState> => getConnectorState()

  // --- secrets -------------------------------------------------------------

  ipcHandle(ipcMain, IPC.SECRET_LIST, (event) => {
    assertMainFrame(event)
    return vault().list() // names + metadata only
  })

  ipcHandle(ipcMain, IPC.SECRET_STATUS, (event) => {
    assertMainFrame(event)
    return vault().status() // { available, backend }
  })

  ipcHandle(ipcMain, IPC.SECRET_SET, (event, name: unknown, value: unknown) => {
    assertMainFrame(event)
    if (!isValidSecretName(name)) throw new IpcValidationError('Invalid secret name')
    if (typeof value !== 'string' || value.length === 0) {
      throw new IpcValidationError('Secret value must be a non-empty string')
    }
    // Vault.set throws (surfaced to the UI) if secure storage is unavailable —
    // it refuses to persist plaintext.
    vault().set(name, value)
    return { ok: true }
  })

  ipcHandle(ipcMain, IPC.SECRET_REMOVE, (event, name: unknown) => {
    assertMainFrame(event)
    if (!isValidSecretName(name)) throw new IpcValidationError('Invalid secret name')
    vault().remove(name)
    return { ok: true }
  })

  // --- MCP connectors ------------------------------------------------------

  ipcHandle(ipcMain, IPC.MCP_LIST_CONNECTORS, (event) => {
    assertMainFrame(event)
    // Static catalog (no secrets) — display data for the settings panel.
    return CONNECTORS.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      description: c.description,
      kind: kindOf(c),
      secrets: c.secrets.map((s) => ({ envVar: s.envVar, label: s.label, hint: s.hint })),
    }))
  })

  ipcHandle(ipcMain, IPC.MCP_ENABLE, (event, id: unknown) => {
    assertMainFrame(event)
    if (!isConnectorId(id)) throw new IpcValidationError('Unknown connector')
    state().enable(id)
    return { ok: true }
  })

  ipcHandle(ipcMain, IPC.MCP_DISABLE, (event, id: unknown) => {
    assertMainFrame(event)
    if (!isConnectorId(id)) throw new IpcValidationError('Unknown connector')
    state().disable(id)
    return { ok: true }
  })

  /**
   * Per-connector runtime status for the UI: enabled? and are all its required
   * secrets present in the vault (so it will actually wire into a run)? No
   * secret value crosses IPC — only presence booleans.
   */
  ipcHandle(ipcMain, IPC.MCP_STATUS, (event) => {
    assertMainFrame(event)
    const enabled = new Set(state().enabled())
    const v = vault()
    return CONNECTORS.map((c) => {
      const need = requiredSecretNames(c.id)
      const missing = need.filter((n) => !v.has(n))
      // A remote-oauth connector is "ready" when it is enabled AND connected (an
      // OAuth record is stored) — it has no env secrets.
      const remote = isRemoteOAuth(c)
      const ep = isRemoteUrl(c) ? getConnectorSettings().get(c.id) : undefined
      const connected = remote
        ? v.has(remoteVaultKey(c.id))
        : isRemoteUrl(c)
          ? !!ep && (ep.auth === 'none' || v.has(remoteVaultKey(c.id)))
          : undefined
      return {
        id: c.id,
        kind: kindOf(c),
        enabled: enabled.has(c.id),
        requiredSecrets: need,
        missingSecrets: missing,
        connected,
        ready: connected === undefined
          ? enabled.has(c.id) && missing.length === 0
          : enabled.has(c.id) && connected,
      }
    })
  })

  // --- Remote OAuth connectors (Path B) ------------------------------------

  /**
   * Run the PKCE loopback flow for a remote-oauth connector against the server's
   * own auth server and persist the REFRESH TOKEN (+ token endpoint/clientId/
   * resource, all non-secret) in the vault, safeStorage-encrypted. No token is
   * ever logged or returned to the renderer — only a { connected } result.
   */
  ipcHandle(ipcMain, IPC.MCP_OAUTH_CONNECT, async (event, id: unknown) => {
    assertMainFrame(event)
    if (!isConnectorId(id)) throw new IpcValidationError('Unknown connector')
    const connector = getConnector(id)
    if (!connector || !isRemoteOAuth(connector) || !connector.remote) {
      return { ok: false as const, error: 'Not a remote OAuth connector.' }
    }
    const clientId = resolveRemoteClientId(id, connector.remote.clientId)
    const deps: RemoteFlowDeps = { fetchFn: nodeFetch, clientId }
    const flow = await runRemoteOAuthFlow(connector.remote, deps)
    if (!flow.ok) return { ok: false as const, error: flow.error }

    const refreshToken = flow.tokens.refreshToken
    if (!refreshToken) {
      return {
        ok: false as const,
        error: 'The server did not return a refresh token — cannot stay connected.',
      }
    }
    const key = remoteVaultKey(id)
    if (!key) return { ok: false as const, error: 'Invalid connector id.' }
    // Vault.set throws if secure storage is unavailable (refuses plaintext).
    getVault().set(
      key,
      serializeRecord({
        refreshToken,
        tokenEndpoint: flow.endpoints.tokenEndpoint,
        clientId: flow.clientId,
        resource: flow.endpoints.resource,
        accessToken: flow.tokens.accessToken,
        accessTokenExpiresAt: flow.tokens.expiresAt,
      }),
    )
    // Enabling on successful connect mirrors the API-key UX (a saved key alone
    // doesn't enable, but connecting is an explicit user action here).
    getConnectorState().enable(id)
    return { ok: true as const, connected: true }
  })

  /**
   * Connect a 'remote-url' connector to the address the person typed. A server
   * that answers without a sign-in is stored as is; one that answers 401 gets
   * the loopback OAuth flow against that address (registering Workspace OS as
   * a client when the server offers it). Enables the connector on success.
   */
  ipcHandle(ipcMain, IPC.MCP_URL_CONNECT, async (event, id: unknown, url: unknown) => {
    assertMainFrame(event)
    if (!isConnectorId(id)) throw new IpcValidationError('Unknown connector')
    const connector = getConnector(id)
    if (!connector || !isRemoteUrl(connector)) return { ok: false as const, error: 'This connector has no address to set.' }
    const norm = normalizeServerUrl(url)
    if (!norm.ok) return { ok: false as const, error: norm.error }
    const probe = await probeMcpServer(norm.url, nodeFetch)
    if (!probe.ok) return { ok: false as const, error: probe.error }
    const key = remoteVaultKey(id)
    if (probe.value === 'open') {
      // A previous sign-in to another server must not ride along.
      if (key && vault().has(key)) vault().remove(key)
      getConnectorSettings().setEndpoint(id, norm.url, 'none')
      getConnectorState().enable(id)
      return { ok: true as const, auth: 'none' as const }
    }
    const configured = process.env[`MCP_OAUTH_${id.toUpperCase().replace(/-/g, '_')}_CLIENT_ID`]?.trim()
    const flow = await runRemoteOAuthFlow(
      { ...connector.remote, url: norm.url, resource: undefined, scopes: connector.remote?.scopes ?? [] },
      { fetchFn: nodeFetch, clientId: configured || undefined },
    )
    if (!flow.ok) return { ok: false as const, error: flow.error }
    if (!flow.tokens.refreshToken) {
      return { ok: false as const, error: 'The server did not return a refresh token — cannot stay connected.' }
    }
    if (!key) return { ok: false as const, error: 'Invalid connector id.' }
    vault().set(
      key,
      serializeRecord({
        refreshToken: flow.tokens.refreshToken,
        tokenEndpoint: flow.endpoints.tokenEndpoint,
        clientId: flow.clientId,
        resource: flow.endpoints.resource,
        accessToken: flow.tokens.accessToken,
        accessTokenExpiresAt: flow.tokens.expiresAt,
      }),
    )
    getConnectorSettings().setEndpoint(id, norm.url, 'oauth')
    getConnectorState().enable(id)
    return { ok: true as const, auth: 'oauth' as const }
  })

  /** Whether chats may run this connector's skill scripts (`uv run`). Off unless switched on. */
  ipcHandle(ipcMain, IPC.MCP_CHAT_SCRIPTS, (event, id: unknown, on: unknown) => {
    assertMainFrame(event)
    if (!isConnectorId(id)) throw new IpcValidationError('Unknown connector')
    if (typeof on !== 'boolean') throw new IpcValidationError('Expected on/off')
    if (!getConnector(id)?.chatScripts) throw new IpcValidationError('This connector has no scripts setting')
    if (!getConnectorSettings().get(id)) return { ok: false as const, error: 'Connect the server first.' }
    getConnectorSettings().setChatScripts(id, on)
    return { ok: true as const }
  })

  /** Connected? (an OAuth record is stored). No token crosses IPC. */
  ipcHandle(ipcMain, IPC.MCP_OAUTH_STATUS, (event, id: unknown) => {
    assertMainFrame(event)
    if (!isConnectorId(id)) throw new IpcValidationError('Unknown connector')
    const key = remoteVaultKey(id)
    return { connected: !!key && vault().has(key) }
  })

  /** Disconnect — remove the stored OAuth record. */
  ipcHandle(ipcMain, IPC.MCP_OAUTH_DISCONNECT, (event, id: unknown) => {
    assertMainFrame(event)
    if (!isConnectorId(id)) throw new IpcValidationError('Unknown connector')
    const key = remoteVaultKey(id)
    if (key) vault().remove(key)
    return { ok: true as const }
  })
}
