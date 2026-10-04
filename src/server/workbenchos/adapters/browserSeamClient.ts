/**
 * BrowserAutomationPort seam client (M5-PRE-001D).
 *
 * The server owns the WorkbenchCore composition; the browser runtime lives in
 * the Electron main process (DECISION_LOG D-006). This client is the only piece
 * of the server that crosses that process boundary: it implements the frozen
 * `BrowserAutomationPortV01` by sending the M5-PRE-001B envelope over loopback
 * HTTP to the Electron-owned listener.
 *
 * Boundaries this client deliberately keeps:
 *   - transport only: no journal, no idempotency store, no request queue;
 *   - exactly one HTTP attempt per call. A lost response is `unknown`; recovery
 *     belongs to the Core journal + observe path (M4-03B-FIX). In particular a
 *     submitUserMessage failure is NEVER resent here;
 *   - no browser implementation detail crosses this boundary: the endpoint is a
 *     plain HTTP URL and the payloads carry only the frozen port types.
 */

import { randomUUID } from 'node:crypto'
import type {
  BrowserAutomationHealth,
  BrowserAutomationPortV01,
  ConversationObservation,
  ConversationRef,
  ObservedMessage,
  SubmitUserMessageInput,
  UserMessageReceipt,
} from '../ports/browserAutomationPort.js'
import {
  BrowserAutomationPortError,
  type BrowserAutomationPortErrorCode,
} from '../ports/browserAutomationPort.js'

export const BROWSER_SEAM_PROTOCOL_VERSION = '0.1'

/** Endpoint + credential injected into the server environment by Electron main. */
export const BROWSER_SEAM_URL_ENV = 'CC_HAHA_BROWSER_SEAM_URL'
export const BROWSER_SEAM_CREDENTIAL_ENV = 'CC_HAHA_BROWSER_SEAM_TOKEN'
const BROWSER_SEAM_HOST = '127.0.0.1'
const BROWSER_SEAM_PATH = '/internal/browser-automation'

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<BrowserAutomationPortErrorCode>([
  'VERSION_MISMATCH',
  'INVALID_REQUEST',
  'IDEMPOTENCY_CONFLICT',
  'NOT_FOUND',
  'UNAVAILABLE',
  'TIMEOUT',
  'PERMISSION_REQUIRED',
  'UNSUPPORTED_CAPABILITY',
  'INTERNAL',
])

type FetchLike = (input: string, init: {
  method: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}) => Promise<Response>

export type BrowserSeamClientOptions = {
  baseUrl: string
  credential: string
  fetchFn?: FetchLike
  /** Overridable for deterministic tests; defaults to a random UUID per call. */
  nextCorrelationId?: () => string
}

export type BrowserSeamClientConfig = {
  baseUrl: string
  credential: string
}

/**
 * Reads the seam endpoint + credential from an environment map.
 * Returns `null` when the browser seam is not configured, which is the
 * fail-closed signal for "this runtime has no browser capability".
 */
export function resolveBrowserSeamConfig(
  env: Record<string, string | undefined>,
): BrowserSeamClientConfig | null {
  const baseUrl = env[BROWSER_SEAM_URL_ENV]?.trim()
  const credential = env[BROWSER_SEAM_CREDENTIAL_ENV]?.trim()
  if (!baseUrl || !credential || !isBrowserSeamUrl(baseUrl)) return null
  return { baseUrl, credential }
}

function isBrowserSeamUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'http:' &&
      url.hostname === BROWSER_SEAM_HOST &&
      url.pathname === BROWSER_SEAM_PATH &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    )
  } catch {
    return false
  }
}

/**
 * Composition hook: builds the seam client from the environment, or `null` when
 * the seam is not configured. The production Core is composed separately by
 * `src/server/workbenchosRuntime.ts`, keeping this adapter factory independent
 * from journal and application-state ownership.
 */
export function createBrowserSeamPortFromEnv(
  env: Record<string, string | undefined>,
  options: { fetchFn?: FetchLike } = {},
): BrowserAutomationPortV01 | null {
  const config = resolveBrowserSeamConfig(env)
  if (config === null) return null
  return createBrowserSeamClient(options.fetchFn === undefined
    ? { baseUrl: config.baseUrl, credential: config.credential }
    : { baseUrl: config.baseUrl, credential: config.credential, fetchFn: options.fetchFn })
}

/** Implements the frozen port against the Electron-owned loopback listener. */
export function createBrowserSeamClient(options: BrowserSeamClientOptions): BrowserAutomationPortV01 {
  const baseUrl = options.baseUrl
  const credential = options.credential
  if (!isBrowserSeamUrl(baseUrl) || credential.trim().length === 0) {
    throw new TypeError('browser seam client requires a loopback endpoint and non-empty credential')
  }
  const fetchFn = options.fetchFn ?? (globalThis.fetch as FetchLike)
  const nextCorrelationId = options.nextCorrelationId ?? (() => randomUUID())

  async function call(
    operation: 'healthCheck' | 'observeConversation' | 'submitUserMessage',
    payload: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const correlationId = nextCorrelationId()
    const envelope = {
      seam_protocol_version: BROWSER_SEAM_PROTOCOL_VERSION,
      correlation_id: correlationId,
      operation,
      deadline_ms: timeoutMs,
      payload,
    }

    let response: Response
    try {
      // Exactly one attempt. No retry loop lives here: a lost response is
      // `unknown`, never permission to repeat an external side effect.
      response = await fetchFn(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw transportFailure(error)
    }

    const parsed = await readEnvelope(response)
    if (parsed === null) throw internalFailure('browser seam returned a malformed response')

    // HTTP-level rejection (an unauthorized caller never learns a correlation id,
    // so the correlation check only applies to accepted requests).
    if (!response.ok) {
      if (parsed.outcome === 'error') throw toPortError(parsed.error)
      throw statusFailure(response.status)
    }

    if (parsed.seam_protocol_version !== BROWSER_SEAM_PROTOCOL_VERSION) {
      throw new BrowserAutomationPortError({
        code: 'VERSION_MISMATCH',
        message: 'browser seam protocol version mismatch',
        retryable: false,
      })
    }
    if (parsed.correlation_id !== correlationId) {
      throw internalFailure('browser seam correlation id mismatch')
    }

    if (parsed.outcome === 'error') {
      throw toPortError(parsed.error)
    }
    if (parsed.outcome !== 'ok') {
      throw internalFailure('browser seam returned an unknown outcome')
    }
    return parsed.payload
  }

  return {
    protocolVersion: '0.1',

    async healthCheck(timeoutMs: number): Promise<BrowserAutomationHealth> {
      const payload = await call('healthCheck', {}, timeoutMs)
      return readHealth(payload)
    },

    async observeConversation(
      input: { conversation_ref: ConversationRef; since_fingerprint?: string },
      timeoutMs: number,
    ): Promise<ConversationObservation> {
      const request = input.since_fingerprint === undefined
        ? { conversation_ref: input.conversation_ref }
        : { conversation_ref: input.conversation_ref, since_fingerprint: input.since_fingerprint }
      const payload = await call('observeConversation', request, timeoutMs)
      return readObservation(payload)
    },

    async submitUserMessage(
      input: SubmitUserMessageInput,
      idempotencyKey: string,
      timeoutMs: number,
    ): Promise<UserMessageReceipt> {
      const payload = await call('submitUserMessage', {
        conversation_ref: input.conversation_ref,
        content: input.content,
        // Passed through untouched: this boundary never reinterprets the Core
        // approval, and never converts it into an execution permission.
        approval_ref: input.approval_ref,
        // The business operation identity travels as its own field. It is never
        // derived from the transport correlation id.
        idempotency_key: idempotencyKey,
      }, timeoutMs)
      return readReceipt(payload)
    },
  }
}

// ---------------------------------------------------------------------------
// Response decoding (fail closed on any unexpected shape)
// ---------------------------------------------------------------------------

type SeamResponseEnvelope = {
  seam_protocol_version?: unknown
  correlation_id?: unknown
  outcome?: unknown
  payload?: unknown
  error?: unknown
}

async function readEnvelope(response: Response): Promise<SeamResponseEnvelope | null> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return null
  }
  if (text.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as SeamResponseEnvelope
  } catch {
    return null
  }
}

function toPortError(error: unknown): BrowserAutomationPortError {
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>
    const code = record.code
    if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code)) {
      const message = typeof record.message === 'string' ? record.message : 'browser seam reported a failure'
      const retryable = record.retryable === true
      const evidenceRef = record.evidence_ref
      return evidenceRef === undefined
        ? new BrowserAutomationPortError({ code: code as BrowserAutomationPortErrorCode, message, retryable })
        : new BrowserAutomationPortError({
          code: code as BrowserAutomationPortErrorCode,
          message,
          retryable,
          evidenceRef: evidenceRef as never,
        })
    }
  }
  return internalFailure('browser seam reported an unrecognized error')
}

function transportFailure(error: unknown): BrowserAutomationPortError {
  const name = error !== null && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name)
    : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    // A timed-out call is `unknown`. It is never retried here.
    return new BrowserAutomationPortError({
      code: 'TIMEOUT',
      message: 'browser seam request timed out',
      retryable: false,
    })
  }
  // Connection refused / reset / transport-level failure. Callers see an
  // unreachable capability, not a business outcome.
  return new BrowserAutomationPortError({
    code: 'UNAVAILABLE',
    message: 'browser seam is unreachable',
    retryable: false,
  })
}

function internalFailure(message: string): BrowserAutomationPortError {
  return new BrowserAutomationPortError({ code: 'INTERNAL', message, retryable: false })
}

/**
 * Fallback mapping for HTTP-level rejections that carry no usable envelope.
 * A rejected caller credential means the capability is unreachable for us — it
 * is never reported as PERMISSION_REQUIRED, which stays reserved for the
 * Core-owned business approval gate.
 */
function statusFailure(status: number): BrowserAutomationPortError {
  if (status === 401 || status === 403) {
    return new BrowserAutomationPortError({
      code: 'UNAVAILABLE',
      message: 'browser seam rejected the caller credential',
      retryable: false,
    })
  }
  if (status === 400 || status === 413) {
    return new BrowserAutomationPortError({
      code: 'INVALID_REQUEST',
      message: 'browser seam rejected the request shape',
      retryable: false,
    })
  }
  if (status === 409) {
    return new BrowserAutomationPortError({
      code: 'VERSION_MISMATCH',
      message: 'browser seam protocol version mismatch',
      retryable: false,
    })
  }
  return internalFailure(`browser seam rejected the request with status ${status}`)
}

function readHealth(payload: unknown): BrowserAutomationHealth {
  const record = requireRecord(payload, 'health payload')
  if (typeof record.available !== 'boolean') throw internalFailure('browser seam health payload is malformed')
  if (!Array.isArray(record.capabilities) || record.capabilities.some(entry => typeof entry !== 'string')) {
    throw internalFailure('browser seam health capabilities are malformed')
  }
  const capabilities = record.capabilities as string[]
  if (record.detail === undefined) {
    return { protocol_version: '0.1', available: record.available, capabilities }
  }
  if (typeof record.detail !== 'string') throw internalFailure('browser seam health detail is malformed')
  return { protocol_version: '0.1', available: record.available, capabilities, detail: record.detail }
}

function readObservation(payload: unknown): ConversationObservation {
  const record = requireRecord(payload, 'observation payload')
  if (typeof record.observed_at !== 'string') throw internalFailure('browser seam observation timestamp is malformed')
  if (typeof record.conversation_fingerprint !== 'string') {
    throw internalFailure('browser seam conversation fingerprint is malformed')
  }
  if (!Array.isArray(record.messages)) throw internalFailure('browser seam observation messages are malformed')
  const messages = record.messages.map((entry): ObservedMessage => {
    const message = requireRecord(entry, 'observed message')
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw internalFailure('browser seam observed message role is malformed')
    }
    if (typeof message.message_ref !== 'string' || message.message_ref.length === 0) {
      throw internalFailure('browser seam observed message reference is malformed')
    }
    if (typeof message.content !== 'string') throw internalFailure('browser seam observed message content is malformed')
    if (typeof message.content_fingerprint !== 'string') {
      throw internalFailure('browser seam observed message fingerprint is malformed')
    }
    if (typeof message.settled !== 'boolean') throw internalFailure('browser seam observed message settled flag is malformed')
    return {
      role: message.role,
      message_ref: message.message_ref,
      content: message.content,
      content_fingerprint: message.content_fingerprint,
      settled: message.settled,
    }
  })
  return {
    observed_at: record.observed_at,
    conversation_fingerprint: record.conversation_fingerprint,
    messages,
  }
}

function readReceipt(payload: unknown): UserMessageReceipt {
  const record = requireRecord(payload, 'receipt payload')
  if (typeof record.message_ref !== 'string' || record.message_ref.length === 0) {
    throw internalFailure('browser seam receipt reference is malformed')
  }
  if (typeof record.accepted_at !== 'string') throw internalFailure('browser seam receipt timestamp is malformed')
  if (typeof record.content_fingerprint !== 'string') {
    throw internalFailure('browser seam receipt fingerprint is malformed')
  }
  return {
    message_ref: record.message_ref,
    accepted_at: record.accepted_at,
    content_fingerprint: record.content_fingerprint,
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw internalFailure(`${label} is malformed`)
  }
  return value as Record<string, unknown>
}
