import {
  addMcpServer,
  authMcpServer,
  cancelMcpOAuthFlow,
  getActionStatus,
  getMcpCatalog,
  getMcpOAuthFlow,
  installMcpCatalogEntry,
  listMcpServers,
  type McpCatalogEntry,
  type McpRegistryEntry,
  removeMcpServer,
  setMcpServerEnabled,
  testMcpServer
} from '@/hermes'
import { MCP_DIRECTORY } from '@/lib/mcp-directory'
import { completeMcpDesktopOAuth } from '@/lib/mcp-dashboard-oauth'
import { prettyName } from '@/lib/text'

/**
 * One connector vocabulary for the whole app.
 *
 * "Connector" is the user-facing noun for an MCP server — Linear, Notion,
 * Jira. Before this module every surface spoke a different dialect: the
 * consent card thought in catalog install actions, the composer pills in
 * directory entries, the Capabilities tab in raw `mcp_servers` rows. Adding a
 * fourth source (the public registry) to each of them separately would have
 * cemented that. Instead they all resolve a `Connector` here and act on its
 * state.
 *
 * Two ideas do most of the work:
 *
 * **A resolution ladder, precedence written down once.** Reviewed catalog →
 * curated vendor directory → public registry. Higher rungs win on name, so a
 * registry entry can never shadow a reviewed manifest, and a rung that fails
 * to answer falls through instead of failing the lookup.
 *
 * **State, not mechanism.** Callers ask "what is this connector's situation"
 * (missing / switched off / signed out / working) and `connect` does whatever
 * that situation requires. That is what lets a no-auth server be a plain
 * switch with no browser round-trip, while an OAuth one opens a tab — from
 * the same click, with no caller branching on transport or auth type.
 */

export type ConnectorTrust = 'catalog' | 'community' | 'verified'
export type ConnectorSource = 'catalog' | 'directory' | 'registry'
/** `unknown` means the source didn't say — resolved by probing, not guessing. */
export type ConnectorAuth = 'api_key' | 'none' | 'oauth' | 'unknown'
export type ConnectorState = 'connected' | 'disabled' | 'needs_auth' | 'not_configured'

export interface Connector {
  name: string
  title: string
  description: string
  url: null | string
  trust: ConnectorTrust
  source: ConnectorSource
  auth: ConnectorAuth
  /** Credentials the user must supply before install (names/prompts only). */
  requiredEnv: { name: string; prompt: string; required: boolean }[]
  /** Vendor docs or website, when the source knows one. */
  docs: string
  /** Registrable domain the registry publisher proved it owns, or "". */
  publisher: string
  /** Registry identity ("com.notion/mcp") — shown so two connectors that slug
   *  the same stay distinguishable. Empty for catalog/directory entries. */
  registryName: string
  /** Catalog entries that clone + build rather than just writing config. */
  needsInstall: boolean
}

const CATALOG_TTL_MS = 5 * 60_000

let catalogCache: { at: number; entries: McpCatalogEntry[] } | null = null

/** Drop memoized lookups (after an install, on profile switch). */
export function invalidateConnectorCache(): void {
  catalogCache = null
}

async function loadCatalog(): Promise<McpCatalogEntry[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.entries
  }

  const { entries } = await getMcpCatalog()

  catalogCache = { at: Date.now(), entries }

  return entries
}

function fromCatalog(entry: McpCatalogEntry): Connector {
  const auth = entry.auth_type === 'oauth' ? 'oauth' : entry.auth_type === 'api_key' ? 'api_key' : 'none'

  return {
    auth,
    description: entry.description,
    docs: entry.source,
    name: entry.name,
    needsInstall: entry.needs_install,
    publisher: '',
    registryName: '',
    requiredEnv: entry.required_env,
    source: 'catalog',
    title: prettyName(entry.name),
    trust: 'catalog',
    url: entry.url
  }
}

function fromRegistry(entry: McpRegistryEntry): Connector {
  // A documented secret header IS the credential requirement; anything else
  // is unknown until we probe, because the registry has no auth field.
  const secretHeaders = entry.headers.filter(header => header.secret)

  return {
    auth: secretHeaders.length > 0 ? 'api_key' : 'unknown',
    description: entry.description,
    docs: entry.website,
    name: entry.name,
    needsInstall: false,
    publisher: entry.publisher,
    registryName: entry.registry_name,
    requiredEnv: secretHeaders.map(header => ({
      name: header.name,
      prompt: header.description || header.name,
      required: header.required
    })),
    source: 'registry',
    title: entry.title || prettyName(entry.name),
    trust: entry.trust,
    url: entry.url
  }
}

/**
 * Resolve connector names down the ladder, in one pass.
 *
 * Unresolvable names are simply absent from the result — a connector the
 * agent invented shouldn't produce a broken row, and the card reports the
 * miss rather than offering a card that cannot work. Registry lookups run
 * only for names the two local rungs didn't answer, so the common case costs
 * one cached catalog read.
 */
export async function resolveConnectors(names: string[]): Promise<Connector[]> {
  const wanted = [...new Set(names.map(name => name.trim().toLowerCase()).filter(Boolean))]
  if (wanted.length === 0) {
    return []
  }

  const resolved = new Map<string, Connector>()

  const catalog = await loadCatalog().catch((): McpCatalogEntry[] => [])
  for (const entry of catalog) {
    if (wanted.includes(entry.name.toLowerCase()) && !resolved.has(entry.name.toLowerCase())) {
      resolved.set(entry.name.toLowerCase(), fromCatalog(entry))
    }
  }

  for (const entry of MCP_DIRECTORY) {
    const key = entry.name.toLowerCase()

    if (wanted.includes(key) && !resolved.has(key)) {
      resolved.set(key, {
        auth: 'oauth',
        description: entry.description,
        docs: entry.docs,
        name: entry.name,
        needsInstall: false,
        publisher: '',
        registryName: '',
        requiredEnv: [],
        source: 'directory',
        title: prettyName(entry.name),
        trust: 'verified',
        url: entry.url
      })
    }
  }

  const missing = wanted.filter(name => !resolved.has(name))

  if (missing.length > 0) {
    const found = await Promise.all(missing.map(name => searchConnectors(name, 8).catch((): Connector[] => [])))

    missing.forEach((name, index) => {
      // Only an exact name hit counts here. The card is about to offer this
      // by name; silently substituting the registry's best fuzzy guess for
      // "notion" would connect something the agent never named.
      const match = found[index]?.find(candidate => candidate.name.toLowerCase() === name)

      if (match) {
        resolved.set(name, match)
      }
    })
  }

  // Preserve the caller's order — it's the order the agent asked in.
  return wanted.map(name => resolved.get(name)).filter((entry): entry is Connector => Boolean(entry))
}

/** Free-text connector search across catalog + registry, catalog first.
 *  Powers the onboarding grid's search box and off-catalog card resolution. */
export async function searchConnectors(query: string, limit = 12): Promise<Connector[]> {
  const needle = query.trim().toLowerCase()
  if (needle.length < 2) {
    return []
  }

  const { searchMcpRegistry } = await import('@/api/mcp')

  const [catalog, registry] = await Promise.all([
    loadCatalog().catch((): McpCatalogEntry[] => []),
    searchMcpRegistry(needle, limit)
      .then(response => response.entries)
      .catch((): McpRegistryEntry[] => [])
  ])

  const results: Connector[] = catalog
    .filter(
      entry => entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle)
    )
    .map(fromCatalog)

  const taken = new Set(results.map(entry => entry.name.toLowerCase()))

  for (const entry of registry) {
    if (!taken.has(entry.name.toLowerCase())) {
      taken.add(entry.name.toLowerCase())
      results.push(fromRegistry(entry))
    }
  }

  return results.slice(0, limit)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * What this connector's situation is right now.
 *
 * Deliberately derived from config alone — cheap, synchronous, no probe.
 * "Configured and switched on" reads as `connected` even if its token expired
 * last night, because finding that out costs a real connection per row. The
 * agent's explicit `authorize` action is the override for the case where it
 * already knows the server answered 401.
 */
export function connectorState(name: string, servers: { name: string; enabled: boolean }[]): ConnectorState {
  const server = servers.find(candidate => candidate.name === name)

  if (!server) {
    return 'not_configured'
  }

  return server.enabled ? 'connected' : 'disabled'
}

export async function loadConnectorStates(names: string[]): Promise<Record<string, ConnectorState>> {
  const servers = await listMcpServers()
    .then(response => response.servers)
    .catch(() => [])

  return Object.fromEntries(names.map(name => [name, connectorState(name, servers)]))
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export type ConnectPhase = 'adding' | 'enabling' | 'installing' | 'probing' | 'signing_in'

export interface ConnectOptions {
  /** Polled at every boundary; true aborts and rolls back. */
  cancelled: () => boolean
  /** Narrates the flow so a row can say "Signing in…" rather than spinning. */
  onPhase?: (phase: ConnectPhase) => void
  /** Credential values for `requiredEnv`, collected by the caller's UI. */
  env?: Record<string, string>
}

export interface ConnectResult {
  /** Tool names the connector brought in, when the flow learned them. */
  tools: string[]
}

/** Cancel sentinel — callers swallow it rather than reporting a failure. */
export class ConnectorCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'ConnectorCancelled'
  }
}

const CATALOG_INSTALL_POLL_MS = 1500

const oauth = (name: string, cancelled: () => boolean) =>
  completeMcpDesktopOAuth({
    cancel: cancelMcpOAuthFlow,
    cancelled,
    openExternal: url => window.hermesDesktop.openExternal(url),
    serverName: name,
    start: authMcpServer,
    status: getMcpOAuthFlow
  })

/**
 * Make a connector usable, whatever that takes.
 *
 * The interesting case is a connector whose auth requirement is `unknown` —
 * every registry entry without a documented secret header. Rather than
 * assuming OAuth and throwing the user at a browser tab that may 404 at
 * /register, the flow *probes*: add the server, try to list its tools, and
 * only fall through to sign-in if the endpoint actually refuses. A public
 * no-auth server therefore connects with a switch and no interruption, which
 * is the behavior that makes "connector" feel like one concept instead of
 * three.
 *
 * Failure and cancellation both roll the config write back. A declined flow
 * must leave no server behind — a half-configured entry squatting in
 * `mcp_servers` would fail every subsequent probe and look like a Hermes bug.
 */
export async function connectConnector(
  connector: Connector,
  state: ConnectorState,
  options: ConnectOptions
): Promise<ConnectResult> {
  const { cancelled, env = {}, onPhase } = options

  const abortIfCancelled = () => {
    if (cancelled()) {
      throw new ConnectorCancelled()
    }
  }

  if (state === 'disabled') {
    onPhase?.('enabling')
    await setMcpServerEnabled(connector.name, true)

    return { tools: [] }
  }

  if (state === 'needs_auth' || state === 'connected') {
    // Already in config — this is a re-auth, so a failure must NOT remove the
    // server the user already had.
    onPhase?.('signing_in')
    const flow = await oauth(connector.name, cancelled)

    return { tools: (flow.tools ?? []).map(tool => tool.name) }
  }

  // Not configured. Catalog entries with a git bootstrap or declared
  // credentials go through the reviewed install path; everything else is a
  // URL we write straight into config.
  if (connector.source === 'catalog' && (connector.needsInstall || connector.requiredEnv.length > 0)) {
    onPhase?.('installing')

    const response = await installMcpCatalogEntry(connector.name, env)

    if (response.background && response.action) {
      for (;;) {
        abortIfCancelled()

        const status = await getActionStatus(response.action, 1)

        if (!status.running) {
          if (status.exit_code !== 0) {
            throw new Error(`Install failed for ${connector.title}`)
          }

          break
        }

        await new Promise(resolve => setTimeout(resolve, CATALOG_INSTALL_POLL_MS))
      }
    }

    if (connector.auth === 'oauth') {
      onPhase?.('signing_in')
      const flow = await oauth(connector.name, cancelled)

      return { tools: (flow.tools ?? []).map(tool => tool.name) }
    }

    return { tools: [] }
  }

  if (!connector.url) {
    throw new Error(`${connector.title} has no endpoint to connect to`)
  }

  onPhase?.('adding')
  await addMcpServer({ name: connector.name, url: connector.url })

  try {
    if (connector.auth === 'none') {
      return { tools: [] }
    }

    if (connector.auth === 'unknown') {
      // Probe before interrupting: plenty of hosted servers are open.
      onPhase?.('probing')
      const probe = await testMcpServer(connector.name)

      abortIfCancelled()

      if (probe.ok) {
        return { tools: probe.tools.map(tool => tool.name) }
      }
    }

    onPhase?.('signing_in')
    const flow = await oauth(connector.name, cancelled)

    return { tools: (flow.tools ?? []).map(tool => tool.name) }
  } catch (error) {
    // Decline means "no connector", not an unauthorized entry left behind.
    // Best-effort: the original error is the one worth reporting.
    await removeMcpServer(connector.name).catch(() => {})
    throw error
  }
}
