/**
 * WorkbenchOS production composition tests.
 *
 * M5-PRE-004 (Phase A): application-root → managed DB path, journal
 * construction, browser seam injection, credential boundary, fail-closed
 * behaviour and the real `startServer()` bootstrap wiring.
 *
 * M5-PRE-006: Codex AgentPort construction, state/scratch authority, model
 * authority and Phase B Core construction. No Chrome, no Electron, no real
 * Codex execution.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  BROWSER_SEAM_CREDENTIAL_ENV,
  BROWSER_SEAM_URL_ENV,
  createBrowserSeamPortFromEnv,
} from '../workbenchos/adapters/browserSeamClient.js'
import type { CodexDiscoveryOutcome } from '../workbenchos/adapters/codexDiscovery.js'
import { WorkbenchCore } from '../workbenchos/core/workbenchCore.js'
import { SqliteJournal } from '../workbenchos/persistence/sqliteJournal.js'
import { FakeAgentPort } from '../workbenchos/testing/fakeAgentPort.js'
import {
  WORKBENCHOS_AGENT_MODEL_ENV,
  WORKBENCHOS_JOURNAL_FILENAME,
  createWorkbenchOSRuntime,
  getWorkbenchOSCompositionFailure,
  getWorkbenchOSRuntime,
  initializeWorkbenchOSRuntime,
  resolveWorkbenchosAgentDirectories,
  resolveWorkbenchosDatabasePath,
  shutdownWorkbenchOSRuntime,
} from '../workbenchosRuntime.js'

// Clearly-fake placeholder credential. Never a real secret.
const CREDENTIAL = 'seam-test-credential-not-a-real-secret'
const SEAM_URL = 'http://127.0.0.1:1/internal/browser-automation'

const temporaryScopes: string[] = []

function makeScope(): string {
  const scope = mkdtempSync(join(tmpdir(), 'workbenchos-composition-'))
  temporaryScopes.push(scope)
  return scope
}

afterAll(async () => {
  await shutdownWorkbenchOSRuntime()
  for (const scope of temporaryScopes.splice(0)) {
    rmSync(scope, { recursive: true, force: true })
  }
})

describe('application-state root → managed database path', () => {
  it('resolves <scope>/cc-haha/db/workbenchos-v1.sqlite and creates only the directory', () => {
    const scope = makeScope()

    const databasePath = resolveWorkbenchosDatabasePath(scope)

    expect(databasePath).toBe(join(scope, 'cc-haha', 'db', WORKBENCHOS_JOURNAL_FILENAME))
    expect(existsSync(join(scope, 'cc-haha', 'db'))).toBe(true)
    // No database file is created by path resolution.
    expect(existsSync(databasePath)).toBe(false)
  })

  it('never resolves into the repository or a temporary path', () => {
    const scope = makeScope()

    const databasePath = resolveWorkbenchosDatabasePath(scope)

    expect(databasePath.startsWith(resolve(scope))).toBe(true)
    expect(databasePath.startsWith(process.cwd())).toBe(false)
    expect(databasePath.includes('workbenchos-v1.sqlite')).toBe(true)
  })
})

describe('journal + browser automation port construction', () => {
  it('constructs the journal from the resolved path via the managed helper', () => {
    const scope = makeScope()
    const seen: string[] = []

    const runtime = createWorkbenchOSRuntime({
      scope,
      env: {},
      createJournal: (databasePath) => {
        seen.push(databasePath)
        return new SqliteJournal({ databasePath })
      },
    })

    expect(seen).toEqual([join(scope, 'cc-haha', 'db', WORKBENCHOS_JOURNAL_FILENAME)])
    expect(runtime.journal).toBeInstanceOf(SqliteJournal)
    expect(runtime.databasePath).toBe(seen[0])
  })

  it('leaves the browser port absent when the seam is not configured (fail closed)', () => {
    const scope = makeScope()

    const runtime = createWorkbenchOSRuntime({ scope, env: {} })

    expect(runtime.browserAutomation).toBeNull()
  })

  it('exposes the browser port through the frozen port surface only', () => {
    const scope = makeScope()

    const runtime = createWorkbenchOSRuntime({
      scope,
      env: { [BROWSER_SEAM_URL_ENV]: SEAM_URL, [BROWSER_SEAM_CREDENTIAL_ENV]: CREDENTIAL },
    })

    const port = runtime.browserAutomation
    expect(port).not.toBeNull()
    expect(port?.protocolVersion).toBe('0.1')
    expect(typeof port?.healthCheck).toBe('function')
    expect(typeof port?.observeConversation).toBe('function')
    expect(typeof port?.submitUserMessage).toBe('function')
    // Nothing else is exposed to Core.
    expect(Object.keys(port as object).sort()).toEqual([
      'healthCheck',
      'observeConversation',
      'protocolVersion',
      'submitUserMessage',
    ])
  })
})

describe('credential boundary', () => {
  it('sends the credential to the seam client but keeps it out of the port object', async () => {
    const scope = makeScope()
    const calls: Array<{ url: string; authorization: string | undefined }> = []

    const runtime = createWorkbenchOSRuntime({
      scope,
      env: { [BROWSER_SEAM_URL_ENV]: SEAM_URL, [BROWSER_SEAM_CREDENTIAL_ENV]: CREDENTIAL },
      createJournal: (databasePath) => new SqliteJournal({ databasePath }),
    })
    const port = runtime.browserAutomation
    expect(port).not.toBeNull()

    // Rebuild the same port with an observable transport to prove the credential
    // travels as a transport header, not as part of any Core-facing value.
    const observablePort = createBrowserSeamPortFromEnv(
      { [BROWSER_SEAM_URL_ENV]: SEAM_URL, [BROWSER_SEAM_CREDENTIAL_ENV]: CREDENTIAL },
      {
        fetchFn: async (url, init) => {
          calls.push({ url, authorization: init.headers.Authorization })
          const request = JSON.parse(init.body) as { correlation_id: string }
          return new Response(
            JSON.stringify({
              seam_protocol_version: '0.1',
              correlation_id: request.correlation_id,
              outcome: 'ok',
              payload: { protocol_version: '0.1', available: true, capabilities: [] },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        },
      },
    )
    expect(observablePort).not.toBeNull()

    await observablePort!.healthCheck(1_000)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(SEAM_URL)
    expect(calls[0]!.authorization).toBe(`Bearer ${CREDENTIAL}`)

    // The credential never appears on the object handed to Core, and neither do
    // browser implementation details.
    const surface = JSON.stringify(port)
    expect(surface).not.toContain(CREDENTIAL)
    expect(surface).not.toContain('9222')
    expect(Object.values(port as object).every(value => typeof value !== 'string' || !value.includes(CREDENTIAL))).toBe(true)
  })
})

describe('server bootstrap composition', () => {
  it('wires the journal path and browser port during startServer()', async () => {
    await shutdownWorkbenchOSRuntime()
    const scope = makeScope()
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousSeamUrl = process.env[BROWSER_SEAM_URL_ENV]
    const previousSeamToken = process.env[BROWSER_SEAM_CREDENTIAL_ENV]
    const previousModel = process.env[WORKBENCHOS_AGENT_MODEL_ENV]
    process.env.CLAUDE_CONFIG_DIR = scope
    process.env[BROWSER_SEAM_URL_ENV] = SEAM_URL
    process.env[BROWSER_SEAM_CREDENTIAL_ENV] = CREDENTIAL
    // No production model configured, so the agent capability must stay absent.
    delete process.env[WORKBENCHOS_AGENT_MODEL_ENV]

    const { startServer, stopServerRuntimeForShutdown } = await import('../index.js')
    const server = startServer(0, '127.0.0.1')
    try {
      const runtime = getWorkbenchOSRuntime()
      expect(runtime).not.toBeNull()
      expect(runtime!.databasePath).toBe(join(scope, 'cc-haha', 'db', WORKBENCHOS_JOURNAL_FILENAME))
      expect(runtime!.browserAutomation).not.toBeNull()
      expect(runtime!.browserAutomation?.protocolVersion).toBe('0.1')
      // Booting the server must not create the database file.
      expect(existsSync(runtime!.databasePath)).toBe(false)
      // Without a production model there is no AgentPort and no Core — and no
      // substitute implementation is invented in their place.
      expect(runtime!.agentPort).toBeNull()
      expect(runtime!.core).toBeNull()
      expect(runtime!.agentFailure?.code).toBe('WORKBENCHOS_AGENT_MODEL_MISSING')
    } finally {
      server.stop(true)
      await stopServerRuntimeForShutdown()
      await shutdownWorkbenchOSRuntime()
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      if (previousSeamUrl === undefined) delete process.env[BROWSER_SEAM_URL_ENV]
      else process.env[BROWSER_SEAM_URL_ENV] = previousSeamUrl
      if (previousSeamToken === undefined) delete process.env[BROWSER_SEAM_CREDENTIAL_ENV]
      else process.env[BROWSER_SEAM_CREDENTIAL_ENV] = previousSeamToken
      if (previousModel === undefined) delete process.env[WORKBENCHOS_AGENT_MODEL_ENV]
      else process.env[WORKBENCHOS_AGENT_MODEL_ENV] = previousModel
    }
    // Booting the real bootstrap (local index open + background startup) is
    // heavier than the default budget; the repo's server runner uses 20s.
  }, 30_000)
})

describe('fail-closed composition', () => {
  it('records the failure instead of falling back to another path or store', async () => {
    await shutdownWorkbenchOSRuntime()
    const scope = makeScope()
    // Occupy the managed sub-directory with a file: the managed layout becomes
    // unusable and the existing helper refuses it.
    writeFileSync(join(scope, 'cc-haha'), 'not a directory')

    expect(() => resolveWorkbenchosDatabasePath(scope)).toThrow()

    const runtime = initializeWorkbenchOSRuntime({ scope, env: {} })

    expect(runtime).toBeNull()
    expect(getWorkbenchOSCompositionFailure()?.code).toBe('LOCAL_INDEX_UNSAFE_PATH')
    // No fallback database was created anywhere.
    expect(existsSync(join(scope, 'cc-haha', 'db'))).toBe(false)
  })
})

describe('production Codex AgentPort composition', () => {
  function stubBinary() {
    const dir = makeScope()
    const path = join(dir, 'codex.exe')
    writeFileSync(path, 'stub', 'utf8')
    return { path, release_dir: 'stub-release', mtime_ms: 1 }
  }

  const found =
    (binary: { path: string; release_dir: string; mtime_ms: number }) =>
    (): CodexDiscoveryOutcome => ({ status: 'found', binary })
  const notFound = (): CodexDiscoveryOutcome => ({
    status: 'not_found',
    searched: ['/nonexistent'],
  })

  it('resolves the agent state/scratch authority under the injected root', () => {
    const scope = makeScope()

    const directories = resolveWorkbenchosAgentDirectories(scope)

    expect(directories.stateDir).toBe(join(scope, 'cc-haha', 'workbenchos', 'agent', 'state'))
    expect(directories.scratchDir).toBe(join(scope, 'cc-haha', 'workbenchos', 'agent', 'scratch'))
    // Path resolution creates nothing; the adapter creates them on submit.
    expect(existsSync(join(scope, 'cc-haha', 'workbenchos'))).toBe(false)
  })

  it('composes the AgentPort and then the Core when every input resolves', () => {
    const runtime = createWorkbenchOSRuntime({
      scope: makeScope(),
      env: { [WORKBENCHOS_AGENT_MODEL_ENV]: 'test-model-id' },
      discoverBinary: found(stubBinary()),
    })

    expect(runtime.agentFailure).toBeNull()
    expect(runtime.agentPort).not.toBeNull()
    expect(runtime.agentPort?.protocolVersion).toBe('0.1')
    // Phase B: the Core is constructed from the production objects.
    expect(runtime.core).toBeInstanceOf(WorkbenchCore)
    expect(runtime.journal).toBeInstanceOf(SqliteJournal)
    // Never a testing adapter.
    expect(runtime.agentPort).not.toBeInstanceOf(FakeAgentPort)
  })

  it('keeps the AgentPort and the Core absent when the model is not configured', () => {
    const runtime = createWorkbenchOSRuntime({
      scope: makeScope(),
      env: {},
      discoverBinary: found(stubBinary()),
    })

    expect(runtime.agentPort).toBeNull()
    expect(runtime.core).toBeNull()
    expect(runtime.agentFailure?.code).toBe('WORKBENCHOS_AGENT_MODEL_MISSING')
    // The journal is still composed: an agent failure never disables it.
    expect(runtime.journal).toBeInstanceOf(SqliteJournal)
  })

  it('keeps the AgentPort and the Core absent when no Codex binary exists', () => {
    const runtime = createWorkbenchOSRuntime({
      scope: makeScope(),
      env: { [WORKBENCHOS_AGENT_MODEL_ENV]: 'test-model-id' },
      discoverBinary: notFound,
    })

    expect(runtime.agentPort).toBeNull()
    expect(runtime.core).toBeNull()
    expect(runtime.agentFailure?.code).toBe('WORKBENCHOS_AGENT_BINARY_NOT_FOUND')
  })
})
