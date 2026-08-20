'use client'

import { type ToolCallMessagePartProps, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { ToolFallback } from '@/components/assistant-ui/tool/fallback'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { AlertCircle, CheckCircle2, Loader2 } from '@/lib/icons'
import { brandFor, brandGlyphStyle } from '@/lib/mcp-brands'
import {
  connectConnector,
  type Connector,
  ConnectorCancelled,
  type ConnectorState,
  type ConnectPhase,
  invalidateConnectorCache,
  loadConnectorStates,
  resolveConnectors
} from '@/lib/mcp-connectors'
import { McpOAuthCancelled } from '@/lib/mcp-dashboard-oauth'
import { prettyName } from '@/lib/text'
import { cn } from '@/lib/utils'
import { $gateway } from '@/store/gateway'
import {
  buildSetupOutcome,
  clearMcpSetupRequest,
  type McpConnectorOutcome,
  type McpSetupOutcome,
  sessionMcpSetupRequest
} from '@/store/mcp-setup'
import { notifyError } from '@/store/notifications'
import { invalidateMcpSuggestionIndex } from '@/store/suggestion-providers/mcp'

import { selectMessageRunning } from './tool/fallback-model'
import { parseMaybeObject } from './tool/fallback-model/format'

/**
 * The inline connector card.
 *
 * One card can offer several connectors, each a row with its own switch, so a
 * task needing Jira *and* Figma asks once instead of blocking twice. Rows
 * default to on: the agent already decided these are relevant, and the switch
 * exists to remove one, not to make the user opt into each.
 *
 * Everything about *how* a connector connects — write config, flip enabled,
 * probe, sign in — belongs to `lib/mcp-connectors`. This component owns the
 * consent surface and the per-row phase presentation, nothing else. That's
 * what lets a no-auth server be a plain switch and an OAuth one open a
 * browser tab from the same click, with no branching here.
 *
 * Each row also owns its own *recovery*. Three connectors is three OAuth
 * flows against three servers — under the MCP auth spec a token is bound to
 * one resource, so partial failure is a property of the protocol and the card
 * only gets to choose whether it represents it honestly. So: one shared
 * Connect is a convenience that fans out into N independent attempts, a pass
 * that leaves anything unconnected keeps the card live with Retry over just
 * those rows, and the tool settles only on a clean sweep or an explicit Done.
 *
 * Consent vocabulary follows the approval bar: primary-tinted action with
 * `⌘⏎`, ghost decline with `Esc`, clarify's focus stand-down so keystrokes
 * meant for the composer are never eaten.
 */

type SetupAction = 'authorize' | 'connect' | 'enable' | 'install'

interface SetupArgs {
  servers: string[]
  action: SetupAction
  reason: string
}

function readSetupArgs(args: unknown): SetupArgs {
  const row = parseMaybeObject(args)
  const rawAction = typeof row.action === 'string' ? row.action : 'connect'

  const listed = Array.isArray(row.servers)
    ? row.servers.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    : []

  const single = typeof row.server === 'string' && row.server.trim() ? [row.server] : []

  return {
    action: rawAction === 'enable' || rawAction === 'authorize' || rawAction === 'install' ? rawAction : 'connect',
    reason: typeof row.reason === 'string' ? row.reason : '',
    servers: [...new Set([...single, ...listed])]
  }
}

/** The tool's settled JSON — the card's outcome plus the tool-only
 *  `unanswered` status (timeout, no user action). */
type SettledResult = Omit<Partial<McpSetupOutcome>, 'status'> & {
  status?: 'unanswered' | McpSetupOutcome['status']
  note?: string
}

const SHELL_CLASS = `${WIDGET_SHELL_CLASS} text-[length:var(--conversation-text-font-size)] text-(--ui-text-primary)`

// Same platform sniff the approval bar uses for its accelerator hint.
const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)

const ICON_CLASS = 'mt-px size-4 shrink-0 text-(--ui-text-tertiary)'

function ConnectorGlyph({ name }: { name: string }) {
  const brand = brandFor(name)

  return brand ? (
    <brand.Icon aria-hidden className="mt-px size-4 shrink-0" style={brandGlyphStyle(brand)} />
  ) : (
    <Codicon className={ICON_CLASS} name="plug" size="1rem" />
  )
}

function SetupLine({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      {trailing}
    </div>
  )
}

export const McpSetupTool = (props: ToolCallMessagePartProps) => {
  // Settled → static outcome line (the flow already ran or was declined).
  if (props.result !== undefined) {
    return <McpSetupSettled {...props} />
  }

  return <McpSetupLive {...props} />
}

const McpSetupLive = (props: ToolCallMessagePartProps) => {
  const messageRunning = useAuiState(selectMessageRunning)

  // Stopped mid-prompt with no result — don't leave a dead interactive panel.
  if (!messageRunning) {
    return <ToolFallback {...props} />
  }

  return <McpSetupPending {...props} />
}

function McpSetupSettled({ args, result }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup
  const fromArgs = useMemo(() => readSetupArgs(args), [args])
  const fromResult = useMemo(() => parseMaybeObject(result) as SettledResult, [result])

  const status = fromResult.status ?? 'error'

  // Older single-connector answers have no `connectors` array; synthesize one
  // so the settled view reads identically for both shapes.
  const connectors: McpConnectorOutcome[] = Array.isArray(fromResult.connectors)
    ? fromResult.connectors
    : [
        {
          server: fromResult.server || fromArgs.servers[0] || '',
          status: status === 'connected' ? 'connected' : status === 'declined' ? 'declined' : 'error'
        }
      ]

  if (status === 'declined' || status === 'unanswered') {
    return (
      <div className={cn(SHELL_CLASS, 'my-1.5 grid gap-1.5')} data-slot="mcp-setup-inline">
        <SetupLine trailing={<Codicon className={ICON_CLASS} name="plug" size="1rem" />}>
          <span className="font-medium italic text-(--ui-text-tertiary)">
            {status === 'declined' ? copy.declined : copy.unanswered}
          </span>
        </SetupLine>
      </div>
    )
  }

  return (
    <div className={cn(SHELL_CLASS, 'my-1.5 grid gap-1')} data-slot="mcp-setup-inline">
      {connectors.map(connector => {
        const ok = connector.status === 'connected'
        const name = prettyName(connector.server)
        const toolCount = Array.isArray(connector.tools) ? connector.tools.length : 0

        return (
          <SetupLine
            key={connector.server}
            trailing={
              ok ? (
                <CheckCircle2 aria-hidden className={cn(ICON_CLASS, 'text-emerald-400')} />
              ) : connector.status === 'skipped' || connector.status === 'declined' ? (
                <Codicon className={ICON_CLASS} name="circle-slash" size="1rem" />
              ) : (
                <AlertCircle aria-hidden className={cn(ICON_CLASS, 'text-destructive')} />
              )
            }
          >
            <span className={cn('font-medium', connector.status === 'skipped' && 'italic text-(--ui-text-tertiary)')}>
              {ok
                ? copy.connected(name)
                : connector.status === 'skipped'
                  ? copy.skipped(name)
                  : connector.status === 'declined'
                    ? copy.declinedOne(name)
                    : copy.failed(name)}
            </span>
            {ok && toolCount > 0 && <span className="ml-2 text-(--ui-text-tertiary)">{copy.toolCount(toolCount)}</span>}
            {connector.detail && connector.status === 'error' ? (
              <p className="mt-0.5 text-(--ui-text-secondary)">{connector.detail}</p>
            ) : null}
          </SetupLine>
        )
      })}
    </div>
  )
}

/** Per-row live phase while the card works through its selection. */
type RowPhase = 'done' | 'failed' | 'idle' | 'working'

interface RowModel {
  connector: Connector
  state: ConnectorState
}

function McpSetupPending({ args }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup
  // The tool row is in whichever session's transcript rendered it — read THAT
  // session's request (primary or tile), not the globally-active one.
  const sessionId = useStore(useSessionView().$runtimeId)
  const $request = useMemo(() => sessionMcpSetupRequest(sessionId), [sessionId])
  const request = useStore($request)
  const gateway = useStore($gateway)
  const fromArgs = useMemo(() => readSetupArgs(args), [args])

  const names = useMemo(
    () => (fromArgs.servers.length > 0 ? fromArgs.servers : (request?.servers ?? [])),
    [fromArgs.servers, request?.servers]
  )

  const action: SetupAction = fromArgs.action ?? request?.action ?? 'connect'
  const reason = fromArgs.reason || request?.reason || ''
  // Names are the identity of this card's offer; join so the resolve effect
  // doesn't re-run on every render just because the array is a new object.
  const namesKey = names.join(',')

  const [rows, setRows] = useState<null | RowModel[]>(null)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  // Terminal per-row results, accumulated ACROSS passes so a retry only has
  // to cover what's still outstanding and an earlier success can't be undone.
  const [results, setResults] = useState<Record<string, McpConnectorOutcome>>({})
  const [inFlight, setInFlight] = useState<null | { name: string; phase: ConnectPhase }>(null)
  const [running, setRunning] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({})
  const [envOpen, setEnvOpen] = useState(false)
  const [unresolved, setUnresolved] = useState<string[]>([])
  // Set when the user cancels mid-flight (a stuck OAuth tab, a hung install).
  // The in-flight pass checks it at every boundary and stops there; the
  // respond carrying whatever had already landed has been sent by then.
  const cancelRef = useRef(false)
  // `results` is what renders; this is what's true *right now*. A pass commits
  // each row the moment it settles, so Esc halfway through still reports the
  // connectors that already succeeded instead of reading a stale closure.
  const resultsRef = useRef<Record<string, McpConnectorOutcome>>({})

  const commitResult = useCallback((name: string, outcome: McpConnectorOutcome) => {
    resultsRef.current = { ...resultsRef.current, [name]: outcome }
    setResults(resultsRef.current)
  }, [])

  // Resolve the offered names down the connector ladder (catalog → curated
  // directory → public registry) and read their current state, once.
  useEffect(() => {
    if (names.length === 0) {
      return
    }

    let live = true

    void (async () => {
      const resolved = await resolveConnectors(names).catch((): Connector[] => [])

      const states = await loadConnectorStates(resolved.map(entry => entry.name)).catch(
        (): Record<string, ConnectorState> => ({})
      )

      if (!live) {
        return
      }

      const found = new Set(resolved.map(entry => entry.name.toLowerCase()))

      setUnresolved(names.filter(name => !found.has(name.trim().toLowerCase())))
      setRows(
        resolved.map(connector => ({
          connector,
          // An explicit `authorize` is the agent saying it already saw a 401,
          // which config alone can't tell us.
          state: action === 'authorize' ? 'needs_auth' : (states[connector.name] ?? 'not_configured')
        }))
      )
      // Pre-selected: the agent proposed these, the switch is for removing one.
      setSelected(Object.fromEntries(resolved.map(entry => [entry.name, true])))
    })()

    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- namesKey is the stable identity of `names`
  }, [action, namesKey])

  // Race: tool.start fires a tick before mcp.setup.request — hold the buttons
  // until the gateway request is wired (same spinner rule as clarify).
  const ready = Boolean(request?.requestId) && rows !== null

  const respond = useCallback(
    async (outcome: McpSetupOutcome) => {
      // Another path (cancel racing completion) may have already resolved this
      // request; the store is the single source of truth, so bail if this
      // session's entry is gone — same guard as the approval bar.
      if (!request || sessionMcpSetupRequest(request.sessionId).get()?.requestId !== request.requestId) {
        return
      }

      if (!gateway) {
        notifyError(new Error(copy.gatewayDisconnected), copy.sendFailed)

        return
      }

      // Clear first: the answer is decided, and an in-flight RPC must not
      // leave a live card that can be answered a second time.
      clearMcpSetupRequest(request.requestId, request.sessionId)

      // Anything that landed changed mcp_servers — reload the live session
      // BEFORE unblocking the tool, or the agent resumes being told the
      // connector is ready while its tool snapshot still lacks it. Reload
      // failure isn't outcome failure: the config landed, tools arrive next
      // session — report it and move on.
      if (outcome.connectors.some(connector => connector.status === 'connected')) {
        try {
          await gateway.request('reload.mcp', { confirm: true, session_id: request.sessionId ?? undefined })
        } catch (error) {
          notifyError(error, copy.reloadFailed)
        }

        // The just-connected servers must stop being suggested immediately.
        invalidateMcpSuggestionIndex()
        invalidateConnectorCache()
      }

      try {
        await gateway.request<{ status?: string }>('mcp.setup.respond', {
          request_id: request.requestId,
          result: JSON.stringify(outcome)
        })
        // tool.complete lands next → McpSetupSettled.
      } catch (error) {
        notifyError(error, copy.sendFailed)
      }
    },
    [copy.gatewayDisconnected, copy.reloadFailed, copy.sendFailed, gateway, request]
  )

  const settle = useCallback(
    async (final: Record<string, McpConnectorOutcome>) => {
      await respond(
        buildSetupOutcome({
          attempted,
          names: (rows ?? []).map(row => row.connector.name),
          results: final,
          selected,
          server: names[0] ?? ''
        })
      )
    },
    [attempted, names, respond, rows, selected]
  )

  const decline = useCallback(() => {
    // While a pass is in flight this is a CANCEL: answer with what landed so
    // far and let the abandoned work notice via cancelRef at its next
    // boundary. Connectors that already succeeded stay reported as connected.
    cancelRef.current = true
    triggerHaptic('cancel')
    void settle(resultsRef.current)
  }, [settle])

  const chosen = useMemo(() => (rows ?? []).filter(row => selected[row.connector.name]), [rows, selected])

  /** Chosen rows that still aren't connected — the target of Connect, and of
   *  every subsequent Retry. */
  const outstanding = useMemo(
    () => chosen.filter(row => results[row.connector.name]?.status !== 'connected'),
    [chosen, results]
  )

  // Credentials the still-unconnected rows declare but the user hasn't filled
  // in yet. Scoped to `outstanding` so a row that already landed never
  // re-prompts for a key on the next pass.
  const missingEnv = useMemo(
    () =>
      outstanding.flatMap(row =>
        row.state === 'not_configured'
          ? row.connector.requiredEnv.filter(env => env.required && !envDraft[env.name]?.trim())
          : []
      ),
    [envDraft, outstanding]
  )

  const approve = useCallback(async () => {
    if (chosen.length === 0) {
      decline()

      return
    }

    if (outstanding.length === 0) {
      // Everything wanted is already connected — Done.
      await settle(resultsRef.current)

      return
    }

    if (missingEnv.length > 0) {
      // Reveal the credential fields; the user approves again once filled.
      setEnvOpen(true)

      return
    }

    cancelRef.current = false
    setRunning(true)
    setAttempted(true)

    let landed = false

    try {
      // Sequential on purpose: two OAuth tabs racing for focus is hostile,
      // and each connector's result should paint before the next starts.
      for (const row of outstanding) {
        if (cancelRef.current) {
          break
        }

        const name = row.connector.name

        setInFlight({ name, phase: 'adding' })

        try {
          const result = await connectConnector(row.connector, row.state, {
            cancelled: () => cancelRef.current,
            env: envDraft,
            onPhase: phase => setInFlight(current => (current?.name === name ? { name, phase } : current))
          })

          commitResult(name, { server: name, status: 'connected', tools: result.tools })
          landed = true
        } catch (error) {
          if (error instanceof ConnectorCancelled || error instanceof McpOAuthCancelled) {
            // A closed sign-in tab says nothing about the other connectors, so
            // it leaves this row retryable and the pass carries on. Esc is the
            // way to stop everything.
            continue
          }

          commitResult(name, {
            detail: error instanceof Error ? error.message : String(error),
            server: name,
            status: 'error'
          })
        } finally {
          setInFlight(null)
        }
      }
    } catch (error) {
      notifyError(error, copy.failed(names[0] ?? ''))
    } finally {
      setRunning(false)
    }

    if (cancelRef.current) {
      // Esc already answered the tool with whatever had landed.
      return
    }

    if (landed) {
      triggerHaptic('submit')
    }

    // Only a clean sweep settles on its own. Anything left unconnected keeps
    // the card live so its row — and only its row — can be retried.
    if (chosen.every(row => resultsRef.current[row.connector.name]?.status === 'connected')) {
      await settle(resultsRef.current)
    }
  }, [chosen, commitResult, copy, decline, envDraft, missingEnv, names, outstanding, settle])

  // ⌘/Ctrl+Enter → approve, Esc → decline/cancel. Same accelerators, same
  // guard shape as the approval bar (tool/approval.tsx). Unlike approve, Esc
  // stays live while a flow is in flight — that's the cancel path. Stands
  // down whenever a focusable control has focus (clarify's rule): a keystroke
  // meant for the composer, a popover, or the card's own credential fields
  // must never silently approve a connect or throw away typed input.
  useEffect(() => {
    if (!ready) {
      return
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) {
        return
      }

      const active = document.activeElement as HTMLElement | null

      if (
        active &&
        (active.isContentEditable || active.matches('a[href], button, input, select, textarea, [role="button"]'))
      ) {
        return
      }

      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        if (!running) {
          event.preventDefault()
          void approve()
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        decline()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)

    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [approve, decline, ready, running])

  const title = copy.connectTitle(
    rows && rows.length > 0 ? rows.map(row => row.connector.title).join(', ') : names.map(prettyName).join(', ')
  )

  if (!ready) {
    return (
      <div className={cn(SHELL_CLASS, 'my-1.5 flex items-center gap-2')} data-slot="mcp-setup-inline">
        <Loader2 aria-hidden className="size-4 animate-spin text-(--ui-text-tertiary)" />
        <span className="text-(--ui-text-tertiary)">{title}</span>
      </div>
    )
  }

  // Every offered name failed to resolve — there is nothing to consent to,
  // so say which ones and let the agent move on rather than showing an
  // approve button that cannot work.
  if (rows.length === 0) {
    return (
      <div className={cn(SHELL_CLASS, 'my-1.5 grid gap-1.5')} data-slot="mcp-setup-inline">
        <SetupLine trailing={<AlertCircle aria-hidden className={cn(ICON_CLASS, 'text-destructive')} />}>
          <span className="font-medium">{copy.notFound(unresolved.map(prettyName).join(', '))}</span>
        </SetupLine>
        <div className="flex items-center gap-2.5">
          <Button
            className="h-6 gap-1.5 rounded-md px-1.5 text-xs font-normal text-(--ui-text-tertiary) hover:text-foreground"
            onClick={decline}
            size="xs"
            variant="ghost"
          >
            {copy.dismiss}
            <span className="text-[0.625rem] opacity-55">Esc</span>
          </Button>
        </div>
      </div>
    )
  }

  const multi = rows.length > 1

  const envFields = outstanding.flatMap(row =>
    row.state === 'not_configured' ? row.connector.requiredEnv.map(env => ({ ...env, owner: row.connector })) : []
  )

  const connectedCount = chosen.filter(row => results[row.connector.name]?.status === 'connected').length
  // A pass ran and left something behind: the card stays live, the action
  // becomes Retry over just those rows, and the decline becomes Done.
  const incomplete = attempted && !running && outstanding.length > 0

  return (
    <div className={cn(SHELL_CLASS, 'my-1.5 grid gap-2')} data-slot="mcp-setup-inline">
      <div className="grid gap-0.5">
        <span className="font-medium leading-(--conversation-line-height)">{title}</span>
        {reason ? <p className="text-(--ui-text-secondary)">{reason}</p> : null}
      </div>

      <div className="grid gap-1" data-slot="mcp-setup-rows">
        {rows.map(row => {
          const outcome = results[row.connector.name]
          const live = inFlight?.name === row.connector.name

          return (
            <ConnectorRow
              checked={selected[row.connector.name] ?? false}
              copy={copy}
              detail={outcome?.status === 'error' ? outcome.detail : undefined}
              key={row.connector.name}
              locked={outcome?.status === 'connected'}
              onToggle={next => setSelected(current => ({ ...current, [row.connector.name]: next }))}
              phase={live ? 'working' : outcome?.status === 'connected' ? 'done' : outcome ? 'failed' : 'idle'}
              phaseLabel={live ? copy.phase[inFlight.phase] : undefined}
              row={row}
              showSwitch={multi}
              working={running}
            />
          )
        })}
      </div>

      {/* Exact counts, not "some failed" — and the per-row reason stays on the
          row, because a summary alone makes the user hunt for what broke. */}
      {incomplete && (
        <p className="text-[0.6875rem] text-(--ui-text-tertiary)">{copy.summary(connectedCount, chosen.length)}</p>
      )}

      {unresolved.length > 0 && (
        <p className="text-[0.6875rem] text-(--ui-text-tertiary)">
          {copy.notFound(unresolved.map(prettyName).join(', '))}
        </p>
      )}

      {envOpen && envFields.length > 0 && (
        <div className="grid gap-2" data-slot="mcp-setup-env">
          <p className="text-[0.6875rem] text-(--ui-text-tertiary)">{copy.envRequired}</p>
          {envFields.map(env => (
            <label className="grid gap-1" key={`${env.owner.name}:${env.name}`}>
              <span className="text-[0.6875rem] text-(--ui-text-secondary)">
                {env.prompt || env.name}
                {env.required ? ' *' : ''}
              </span>
              <Input
                className="h-7 text-xs"
                onChange={event => setEnvDraft(prev => ({ ...prev, [env.name]: event.currentTarget.value }))}
                type="password"
                value={envDraft[env.name] ?? ''}
              />
            </label>
          ))}
        </div>
      )}

      {/* Same strip as the tool approval bar (tool/approval.tsx): a bordered
          primary-tinted action plus a quiet ghost decline, with the matching
          keyboard hints. One consent vocabulary across the transcript. */}
      <div className="flex items-center gap-2.5">
        <div className="inline-flex h-6 items-stretch overflow-hidden rounded-md border border-primary/25 bg-primary/10 text-primary">
          <Button
            className="h-full gap-1 rounded-none px-2 text-xs font-medium text-primary hover:bg-primary/15 hover:text-primary"
            disabled={running || chosen.length === 0}
            onClick={() => void approve()}
            size="xs"
            variant="ghost"
          >
            {running ? <Loader2 className="size-3 animate-spin" /> : incomplete ? copy.retryAction : copy.connectAction}
            {!running && <span className="text-[0.625rem] text-primary/60">{isMac ? '⌘⏎' : 'Ctrl⏎'}</span>}
          </Button>
        </div>
        {/* Never disabled: while a flow is in flight this is the cancel —
            a stuck OAuth tab or hung install must always have a way out.
            Once something has landed it becomes Done: leaving with two of
            three connected is a real answer, not a decline. */}
        <Button
          className="h-6 gap-1.5 rounded-md px-1.5 text-xs font-normal text-(--ui-text-tertiary) hover:text-foreground"
          onClick={decline}
          size="xs"
          variant="ghost"
        >
          {running ? t.common.cancel : connectedCount > 0 ? copy.done : copy.decline}
          <span className="text-[0.625rem] opacity-55">Esc</span>
        </Button>
      </div>
    </div>
  )
}

function ConnectorRow({
  checked,
  copy,
  detail,
  locked,
  onToggle,
  phase,
  phaseLabel,
  row,
  showSwitch,
  working
}: {
  checked: boolean
  copy: ReturnType<typeof useI18n>['t']['assistant']['mcpSetup']
  detail?: string
  locked: boolean
  onToggle: (next: boolean) => void
  phase: RowPhase
  phaseLabel?: string
  row: RowModel
  showSwitch: boolean
  working: boolean
}) {
  const { connector, state } = row

  // What the endpoint actually is. VS Code's trust dialog links the config
  // it's about to trust; same idea — the user should see the host before
  // approving, especially for an unreviewed publisher.
  const endpoint = connector.url ?? copy.catalogSource

  const stateLabel = state === 'disabled' ? copy.stateDisabled : state === 'needs_auth' ? copy.stateNeedsAuth : null

  return (
    <div className={cn('flex items-start gap-2 rounded-md py-0.5', !checked && 'opacity-45')} data-slot="mcp-setup-row">
      {phase === 'working' ? (
        <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-(--ui-text-tertiary)" />
      ) : phase === 'done' ? (
        <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-400" />
      ) : phase === 'failed' ? (
        <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <ConnectorGlyph name={connector.name} />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="font-medium">{connector.title}</span>
          <TrustBadge connector={connector} copy={copy} />
          {/* While a row is working its phase replaces the resting state —
              "Signing in…" is the one the user needs, because the browser
              tab that just took focus is otherwise unexplained. */}
          {phaseLabel ? (
            <span className="text-[0.6875rem] text-(--ui-text-tertiary)">{phaseLabel}</span>
          ) : (
            stateLabel && <span className="text-[0.6875rem] text-(--ui-text-tertiary)">{stateLabel}</span>
          )}
        </div>
        {connector.description ? <p className="truncate text-(--ui-text-secondary)">{connector.description}</p> : null}
        {detail ? <p className="text-[0.6875rem] text-destructive">{detail}</p> : null}
        <p className="truncate text-[0.6875rem] text-(--ui-text-tertiary)">{endpoint}</p>
      </div>

      {showSwitch && (
        <Switch
          aria-label={connector.title}
          checked={checked}
          className="mt-0.5 shrink-0 cursor-pointer"
          disabled={working || locked}
          onCheckedChange={onToggle}
          size="xs"
        />
      )}
    </div>
  )
}

/**
 * How much the source vouches for this connector.
 *
 * Three honest statements, not a rating. Catalog entries were reviewed in a
 * PR. `verified` means only that the publisher proved it owns the domain
 * serving the endpoint — real and checkable, but not an endorsement, so the
 * badge names the domain rather than saying "trusted". Community means
 * nothing ties the two together, and that one gets a warning tint because it
 * is the case where reading the endpoint line actually matters.
 */
function TrustBadge({
  connector,
  copy
}: {
  connector: Connector
  copy: ReturnType<typeof useI18n>['t']['assistant']['mcpSetup']
}) {
  if (connector.trust === 'catalog') {
    return <span className="text-[0.6875rem] text-(--ui-text-tertiary)">{copy.trustCatalog}</span>
  }

  if (connector.trust === 'verified') {
    return (
      <Tip label={copy.trustVerifiedTip(connector.publisher || connector.name)}>
        <span className="text-[0.6875rem] text-(--ui-text-tertiary)">
          {connector.publisher ? copy.trustVerified(connector.publisher) : copy.trustOfficial}
        </span>
      </Tip>
    )
  }

  return (
    <Tip label={copy.trustCommunityTip}>
      <span className="inline-flex items-center gap-1 text-[0.6875rem] text-amber-500">
        <Codicon name="warning" size="0.6875rem" />
        {copy.trustCommunity}
      </span>
    </Tip>
  )
}
