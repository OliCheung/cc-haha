/**
 * WorkbenchOS production composition.
 *
 * Wires the already-frozen WorkbenchOS boundaries into the real server
 * bootstrap:
 *
 *   existing application-state root        src/utils/envUtils.ts
 *          ↓
 *   existing managed database path helper  services/localIndex/managedDatabasePath.ts
 *          ↓
 *   SqliteJournal                          workbenchos/persistence/sqliteJournal.ts
 *          ↓
 *   BrowserAutomationPortV01               workbenchos/adapters/browserSeamClient.ts
 *          ↓
 *   AgentPortV01 (Codex)                   workbenchos/adapters/codexAdapter.ts
 *          ↓
 *   WorkbenchCore                          workbenchos/core/workbenchCore.ts
 *
 * Why this module exists (and why it must live here): the dependency boundary
 * forbids `src/server/workbenchos/**` from importing `src/**`, so the
 * composition of the existing root resolver, the managed-path helper and the
 * adapters cannot happen inside that subtree.
 *
 * It introduces no second state root, no fallback path and no DI container:
 * every input comes from the resolvers frozen by M5-PRE-002 / M5-PRE-003 /
 * M5-PRE-006. A missing production input never produces a substitute — it
 * produces null plus a recorded reason, and never silently disables the
 * journal.
 *
 * The journal is CONSTRUCTED here but only OPENED on first use
 * (`runtime.openJournal()`), so booting the server never creates a database
 * file. The agent state/scratch directories are resolved but not created; the
 * adapter creates them when a run is actually submitted.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { prepareManagedDatabasePath } from './services/localIndex/managedDatabasePath.js'
import { createBrowserSeamPortFromEnv } from './workbenchos/adapters/browserSeamClient.js'
import {
  CODEX_CHILD_ENV_ALLOWLIST,
  createCodexAdapter,
} from './workbenchos/adapters/codexAdapter.js'
import {
  discoverCodexBinary,
  type CodexDiscoveryOutcome,
} from './workbenchos/adapters/codexDiscovery.js'
import { createWorkerProcessHost } from './workbenchos/adapters/workerProcessHost.js'
import { WorkbenchCore } from './workbenchos/core/workbenchCore.js'
import type { AgentPortV01 } from './workbenchos/ports/agentPort.js'
import type { BrowserAutomationPortV01 } from './workbenchos/ports/browserAutomationPort.js'
import { SqliteJournal } from './workbenchos/persistence/sqliteJournal.js'

/** Fixed by M5-PRE-003 §8 (existing managed layout: <root>/cc-haha/db/<name>). */
export const WORKBENCHOS_JOURNAL_FILENAME = 'workbenchos-v1.sqlite'

/**
 * M5-PRE-006 §11: the production model is an explicit environment input. There
 * is deliberately no hardcoded model and no reliance on the CLI's own default.
 */
export const WORKBENCHOS_AGENT_MODEL_ENV = 'CC_HAHA_WORKBENCHOS_AGENT_MODEL'

/** Stable project identity written into the task envelope and its ingest hash. */
export const WORKBENCHOS_PROJECT_ID = 'workbenchos'

/** Upper bound for every AgentPort call; mirrors the frozen smoke precedent. */
export const WORKBENCHOS_AGENT_PORT_TIMEOUT_MS = 60_000

/** M5-PRE-006 §10: state/scratch authority, under the existing application root. */
export const WORKBENCHOS_AGENT_STATE_DIRNAME = 'state'
export const WORKBENCHOS_AGENT_SCRATCH_DIRNAME = 'scratch'

export type WorkbenchOSAgentDirectories = {
  /** Durable Codex run records + submission index root. */
  readonly stateDir: string
  /** Schema / last-message scratch root. */
  readonly scratchDir: string
}

export type WorkbenchOSRuntime = {
  /** Absolute path of the authoritative WorkbenchOS journal. */
  readonly databasePath: string
  /** Browser automation seam port, or null when the seam is not configured. */
  readonly browserAutomation: BrowserAutomationPortV01 | null
  /** Production Codex AgentPort, or null when a required input is absent. */
  readonly agentPort: AgentPortV01 | null
  /** Resolved agent state/scratch authority (directories are not created here). */
  readonly agentDirectories: WorkbenchOSAgentDirectories
  /** Why the AgentPort (or the Core) could not be composed; null when it could. */
  readonly agentFailure: WorkbenchOSCompositionFailure | null
  /** Constructed journal handle (not opened yet). */
  readonly journal: SqliteJournal
  /** Production Core, or null while no AgentPort can be composed. */
  readonly core: WorkbenchCore | null
  /** Opens the journal (idempotent); creates + bootstraps it on first call. */
  openJournal(): Promise<void>
  /** Closes the journal (idempotent). */
  closeJournal(): Promise<void>
}

export type WorkbenchOSRuntimeOptions = {
  /** Application-state root; defaults to the existing resolver. */
  scope?: string
  /** Environment used for the browser seam endpoint + credential + model. */
  env?: Record<string, string | undefined>
  /** Injectable journal factory (tests). */
  createJournal?: (databasePath: string) => SqliteJournal
  /** Injectable Codex binary discovery (tests). */
  discoverBinary?: () => CodexDiscoveryOutcome
}

export type WorkbenchOSCompositionFailure = {
  code: string
  message: string
}

/**
 * Resolves the authoritative journal path through the existing resolvers and
 * prepares its managed directory.
 *
 * `prepareManagedDatabasePath` (the helper every existing production database
 * uses) enforces `<scope>/cc-haha/db/<filename>` and refuses symlinked or
 * hard-linked descendants. Nothing here invents a path: `scope` comes from the
 * frozen application-state root, and the layout comes from that helper.
 */
export function resolveWorkbenchosDatabasePath(
  scope: string = getClaudeConfigHomeDir(),
): string {
  const databasePath = join(scope, 'cc-haha', 'db', WORKBENCHOS_JOURNAL_FILENAME)
  prepareManagedDatabasePath({
    databasePath,
    filename: WORKBENCHOS_JOURNAL_FILENAME,
    scope,
  })
  return databasePath
}

/**
 * M5-PRE-006 §10: the agent state/scratch authority lives under the same
 * application root as every other managed directory. No new resolver is
 * introduced and nothing is created here.
 */
export function resolveWorkbenchosAgentDirectories(
  scope: string = getClaudeConfigHomeDir(),
): WorkbenchOSAgentDirectories {
  const agentRoot = join(scope, 'cc-haha', 'workbenchos', 'agent')
  return {
    stateDir: join(agentRoot, WORKBENCHOS_AGENT_STATE_DIRNAME),
    scratchDir: join(agentRoot, WORKBENCHOS_AGENT_SCRATCH_DIRNAME),
  }
}

type AgentPortComposition =
  | { ok: true; agentPort: AgentPortV01 }
  | { ok: false; failure: WorkbenchOSCompositionFailure }

/**
 * Builds the production Codex AgentPort. Every required input is resolved from a
 * frozen authority; when one is missing the outcome is a recorded failure, never
 * a substitute implementation (M5-PRE-006 §9).
 *
 * `workspace_dir` is deliberately NOT defaulted: the Core is denied runtime
 * handles (M0-02 §13) and no production workspace authority is frozen, so a
 * submission carrying no `workspace_ref` fails closed with INVALID_REQUEST
 * instead of silently running in an invented directory.
 */
function composeCodexAgentPort(options: {
  env: Record<string, string | undefined>
  scope: string
  discoverBinary: () => CodexDiscoveryOutcome
  clock: { now(): string }
  ids: { next(): string }
}): AgentPortComposition {
  const modelId = options.env[WORKBENCHOS_AGENT_MODEL_ENV]
  if (typeof modelId !== 'string' || modelId.trim().length === 0) {
    return {
      ok: false,
      failure: {
        code: 'WORKBENCHOS_AGENT_MODEL_MISSING',
        message: `${WORKBENCHOS_AGENT_MODEL_ENV} is not set; no model default is substituted`,
      },
    }
  }

  const discovery = options.discoverBinary()
  if (discovery.status !== 'found') {
    return {
      ok: false,
      failure: {
        code: 'WORKBENCHOS_AGENT_BINARY_NOT_FOUND',
        message: `no codex binary under ${discovery.searched.join(', ')}`,
      },
    }
  }

  const directories = resolveWorkbenchosAgentDirectories(options.scope)
  return {
    ok: true,
    agentPort: createCodexAdapter({
      binary_path: discovery.binary.path,
      state_dir: directories.stateDir,
      scratch_dir: directories.scratchDir,
      model_id: modelId.trim(),
      sandbox: 'read-only',
      // M5-PRE-006 §13-§15: the child receives an explicit allowlist, so no
      // server credential (browser seam, local/pet access token) reaches the CLI.
      child_env_allowlist: CODEX_CHILD_ENV_ALLOWLIST,
      host: createWorkerProcessHost(),
      clock: options.clock,
      ids: options.ids,
    }),
  }
}

/**
 * Builds the WorkbenchOS persistence + browser seam + agent objects.
 * Side-effect free: the database file is only created when `openJournal()` runs,
 * and the agent directories are only created when a run is actually submitted.
 */
export function createWorkbenchOSRuntime(
  options: WorkbenchOSRuntimeOptions = {},
): WorkbenchOSRuntime {
  const scope = options.scope ?? getClaudeConfigHomeDir()
  const env = options.env ?? process.env
  const databasePath = resolveWorkbenchosDatabasePath(scope)
  // Null when the seam is not configured — the fail-closed signal for
  // "this runtime has no browser capability". No substitute port is created.
  const browserAutomation = createBrowserSeamPortFromEnv(env)
  const journal = (options.createJournal ?? ((path: string) => new SqliteJournal({ databasePath: path })))(databasePath)
  const agentDirectories = resolveWorkbenchosAgentDirectories(scope)
  const clock = { now: () => new Date().toISOString() }
  const ids = { next: () => randomUUID() }

  // An AgentPort failure must never disable the journal (M5-PRE-006 §22), so it
  // is captured and reported instead of thrown.
  let agentFailure: WorkbenchOSCompositionFailure | null = null
  let agentPort: AgentPortV01 | null = null
  const composed = composeCodexAgentPort({
    env,
    scope,
    discoverBinary: options.discoverBinary ?? discoverCodexBinary,
    clock,
    ids,
  })
  if (composed.ok) agentPort = composed.agentPort
  else agentFailure = composed.failure

  // Phase B (M5-PRE-006 §21): the Core is constructed only when a real AgentPort
  // exists. No fallback port is ever substituted, and a failure here still
  // leaves the journal composed.
  let core: WorkbenchCore | null = null
  if (agentPort !== null) {
    try {
      core = new WorkbenchCore({
        journal,
        agentPort,
        ...(browserAutomation === null ? {} : { browserAutomation }),
        clock,
        ids,
        project_id: WORKBENCHOS_PROJECT_ID,
        port_timeout_ms: WORKBENCHOS_AGENT_PORT_TIMEOUT_MS,
      })
    } catch (error) {
      core = null
      agentFailure = describeCompositionFailure(error, 'WORKBENCHOS_CORE_COMPOSITION_FAILED')
    }
  }

  let opened = false
  return {
    databasePath,
    browserAutomation,
    agentPort,
    agentDirectories,
    agentFailure,
    journal,
    core,
    async openJournal(): Promise<void> {
      if (opened) return
      await journal.open()
      opened = true
    },
    async closeJournal(): Promise<void> {
      if (!opened) return
      opened = false
      await journal.close()
    },
  }
}

let activeRuntime: WorkbenchOSRuntime | null = null
let compositionFailure: WorkbenchOSCompositionFailure | null = null
let agentCompositionFailure: WorkbenchOSCompositionFailure | null = null

/**
 * Composition entry point called by the server bootstrap.
 *
 * Fails closed at the capability boundary: when the journal path or the seam
 * port cannot be constructed, the runtime stays absent and the reason is
 * recorded. It never falls back to a repo-local, temporary or random database,
 * and never substitutes a different store or port. An AgentPort failure is
 * reported separately and never disables the journal.
 */
export function initializeWorkbenchOSRuntime(
  options: WorkbenchOSRuntimeOptions = {},
): WorkbenchOSRuntime | null {
  if (activeRuntime !== null) return activeRuntime
  try {
    const runtime = createWorkbenchOSRuntime(options)
    activeRuntime = runtime
    compositionFailure = null
    agentCompositionFailure = runtime.agentFailure
    return runtime
  } catch (error) {
    activeRuntime = null
    agentCompositionFailure = null
    compositionFailure = describeCompositionFailure(error)
    return null
  }
}

export function getWorkbenchOSRuntime(): WorkbenchOSRuntime | null {
  return activeRuntime
}

export function getWorkbenchOSCompositionFailure(): WorkbenchOSCompositionFailure | null {
  return compositionFailure
}

/** Why no production AgentPort (or Core) could be composed, when that happened. */
export function getWorkbenchOSAgentFailure(): WorkbenchOSCompositionFailure | null {
  return agentCompositionFailure
}

/** Closes the active journal (if any) and clears the composition registry. */
export async function shutdownWorkbenchOSRuntime(): Promise<void> {
  const runtime = activeRuntime
  activeRuntime = null
  agentCompositionFailure = null
  if (runtime !== null) await runtime.closeJournal()
}

function describeCompositionFailure(
  error: unknown,
  fallbackCode = 'WORKBENCHOS_COMPOSITION_FAILED',
): WorkbenchOSCompositionFailure {
  const code =
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? String((error as { code: string }).code)
      : fallbackCode
  return { code, message: error instanceof Error ? error.message : String(error) }
}
