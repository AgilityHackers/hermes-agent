import { describe, expect, it } from 'vitest'

import { buildSetupOutcome, type McpConnectorOutcome } from './mcp-setup'

const all = (...names: string[]) => Object.fromEntries(names.map(name => [name, true]))

const results = (...entries: McpConnectorOutcome[]) => Object.fromEntries(entries.map(entry => [entry.server, entry]))

describe('buildSetupOutcome', () => {
  it('reports partial when some connectors landed and some failed', () => {
    const outcome = buildSetupOutcome({
      attempted: true,
      names: ['linear', 'n8n', 'notion'],
      results: results(
        { server: 'linear', status: 'connected', tools: ['issues'] },
        { server: 'n8n', status: 'connected' },
        { detail: 'authorization denied', server: 'notion', status: 'error' }
      ),
      selected: all('linear', 'n8n', 'notion'),
      server: 'linear'
    })

    expect(outcome.status).toBe('partial')
    // The successes survive the failure — that's the whole point.
    expect(outcome.connectors.filter(row => row.status === 'connected').map(row => row.server)).toEqual([
      'linear',
      'n8n'
    ])
    expect(outcome.connectors.find(row => row.server === 'notion')?.detail).toBe('authorization denied')
  })

  it('is connected only when nothing failed', () => {
    const outcome = buildSetupOutcome({
      attempted: true,
      names: ['linear', 'n8n'],
      results: results({ server: 'linear', status: 'connected' }, { server: 'n8n', status: 'connected' }),
      selected: all('linear', 'n8n'),
      server: 'linear'
    })

    expect(outcome.status).toBe('connected')
  })

  it('is error when every attempt failed', () => {
    const outcome = buildSetupOutcome({
      attempted: true,
      names: ['notion'],
      results: results({ detail: 'unreachable', server: 'notion', status: 'error' }),
      selected: all('notion'),
      server: 'notion'
    })

    expect(outcome.status).toBe('error')
  })

  it('declines rows the user never ran, and skips the ones they switched off', () => {
    const outcome = buildSetupOutcome({
      attempted: false,
      names: ['linear', 'n8n'],
      results: {},
      selected: { linear: true, n8n: false },
      server: 'linear'
    })

    expect(outcome.status).toBe('declined')
    expect(outcome.connectors).toEqual([
      { server: 'linear', status: 'declined' },
      { server: 'n8n', status: 'skipped' }
    ])
  })

  it('skips rather than declines a row abandoned partway through a pass', () => {
    // A closed sign-in tab is not a refusal of the connector, so the agent
    // should read it as "offered, not answered" rather than "user said no".
    const outcome = buildSetupOutcome({
      attempted: true,
      names: ['linear', 'notion'],
      results: results({ server: 'linear', status: 'connected' }),
      selected: all('linear', 'notion'),
      server: 'linear'
    })

    expect(outcome.status).toBe('connected')
    expect(outcome.connectors.find(row => row.server === 'notion')?.status).toBe('skipped')
  })

  it('keeps every offered connector in the answer, in the order asked', () => {
    const outcome = buildSetupOutcome({
      attempted: true,
      names: ['notion', 'linear', 'n8n'],
      results: results({ server: 'linear', status: 'connected' }),
      selected: all('notion', 'linear', 'n8n'),
      server: 'notion'
    })

    expect(outcome.connectors.map(row => row.server)).toEqual(['notion', 'linear', 'n8n'])
  })
})
