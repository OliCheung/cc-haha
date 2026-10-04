/**
 * Browser Seam — Electron-main HTTP listener for the BrowserAutomationPort seam
 * (M5-PRE-001D).
 *
 * This module is TRANSPORT ONLY. It decodes the frozen seam envelope
 * (M5-PRE-001B §6/§7), validates a dedicated browser-seam credential, dispatches
 * one of the three existing port operations to the in-process adapter and returns
 * the normalized result.
 *
 * It deliberately owns no business state:
 *   - no journal, no idempotency store, no request queue;
 *   - no approval decisions (approval_ref is passed through untouched);
 *   - no retry of submitUserMessage (a lost response is `unknown`, and recovery
 *     belongs to WorkbenchCore's journal + observe path, M4-03B-FIX).
 *
 * The listener binds 127.0.0.1 only and is never exposed publicly.
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type {
  BrowserAutomationHealth,
  BrowserAutomationPortV01,
  ConversationObservation,
  ConversationRef,
  SubmitUserMessageInput,
  UserMessageReceipt,
} from '../../../src/server/workbenchos/ports/browserAutomationPort.js'
import { BrowserAutomationPortError } from '../../../src/server/workbenchos/ports/browserAutomationPort.js'
import { ChatGptBrowserAutomationAdapter } from './adapter.js'
import { CdpChatGptDriver } from './cdpChatGptDriver.js'
import { InMemoryIdempotencyStore } from './idempotency.js'

/** Loopback only. Never 0.0.0.0 / :: / *. */
export const BROWSER_SEAM_HOST = '127.0.0.1'

/** The single internal endpoint. There is intentionally one route, not one per operation. */
export const BROWSER_SEAM_PATH = '/internal/browser-automation'

/** Envelope protocol version (M5-PRE-001B §15). */
export const BROWSER_SEAM_PROTOCOL_VERSION = '0.1'

/** Endpoint handed to the server sidecar through the existing env injection. */
export const BROWSER_SEAM_URL_ENV = 'CC_HAHA_BROWSER_SEAM_URL'

/** Dedicated browser-seam credential. Not a business approval; not a user token. */
export const BROWSER_SEAM_CREDENTIAL_ENV = 'CC_HAHA_BROWSER_SEAM_TOKEN'

export const BROWSER_SEAM_MAX_BODY_BYTES = 1024 * 1024

export type BrowserSeamServer = {
  /** Full request URL, e.g. `http://127.0.0.1:41234/internal/browser-automation`. */
  readonly url: string
  /** Bound host as reported by the OS socket (`127.0.0.1`). */
  readonly host: string
  /** Bound port as reported by the OS socket. */
  readonly port: number
  close(): Promise<void>
}

export type BrowserSeamServerOptions = {
  port: BrowserAutomationPortV01
  credential: string
  host?: string
}

type SeamRequestEnvelope = {
  seam_protocol_version?: unknown
  correlation_id?: unknown
  operation?: unknown
  deadline_ms?: unknown
  payload?: unknown
}

type SeamErrorBody = {
  code: string
  message: string
  retryable: boolean
  evidence_ref?: unknown
}

type SeamResponseEnvelope = {
  seam_protocol_version: string
  correlation_id: string
  outcome: 'ok' | 'error'
  payload?: unknown
  error?: SeamErrorBody
}

/**
 * Creates the loopback HTTP listener exposed to the server sidecar.
 *
 * The adapter is injected, so the transport can be tested with a scriptable port
 * and the wiring stays explicit at the composition point.
 */
export async function createBrowserSeamServer(
  options: BrowserSeamServerOptions,
): Promise<BrowserSeamServer> {
  const host = options.host ?? BROWSER_SEAM_HOST
  const credential = options.credential
  if (credential.length === 0) {
    throw new Error('browser seam credential must not be empty')
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, options.port, credential)
  })
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('could not resolve the browser seam port')
  }

  return {
    url: `http://${host}:${address.port}${BROWSER_SEAM_PATH}`,
    host,
    port: address.port,
    close: () => closeServer(server),
  }
}

/**
 * Builds the production seam port: the existing, already-verified adapter with
 * its CDP driver. The driver stays lazy — no connection is made until a request
 * actually needs the browser.
 */
export function createChatGptBrowserSeamPort(): BrowserAutomationPortV01 {
  return new ChatGptBrowserAutomationAdapter({
    driver: new CdpChatGptDriver(),
    // Non-authoritative, process-local only. Cross-restart recovery is the Core
    // journal's responsibility (D-INMEM is deferred to L2 and unchanged here).
    idempotency: new InMemoryIdempotencyStore(),
  })
}

/** Production factory used by the Electron server runtime. */
export async function createChatGptBrowserSeamServer(credential: string): Promise<BrowserSeamServer> {
  return await createBrowserSeamServer({ port: createChatGptBrowserSeamPort(), credential })
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  port: BrowserAutomationPortV01,
  credential: string,
): Promise<void> {
  try {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', `http://${BROWSER_SEAM_HOST}`)

    if (url.pathname !== BROWSER_SEAM_PATH) {
      sendEnvelope(response, 404, errorEnvelope('', 'INVALID_REQUEST', 'unknown browser seam route'))
      return
    }
    if (method !== 'POST') {
      response.writeHead(405, { Allow: 'POST', Connection: 'close' })
      response.end()
      return
    }
    if (!isAuthorized(request.headers.authorization, credential)) {
      // Transport authentication failure. It is NOT a business approval failure,
      // so it must not be reported as PERMISSION_REQUIRED (that code stays reserved
      // for the Core-owned approval gate). From the dialer's perspective the
      // capability is simply not reachable.
      sendEnvelope(
        response,
        401,
        errorEnvelope('', 'UNAVAILABLE', 'browser seam caller is not authorized'),
      )
      return
    }

    const rawBody = await readBody(request)
    if (rawBody === null) {
      sendEnvelope(response, 413, errorEnvelope('', 'INVALID_REQUEST', 'browser seam request body too large'))
      return
    }

    let envelope: SeamRequestEnvelope
    try {
      envelope = JSON.parse(rawBody) as SeamRequestEnvelope
    } catch {
      sendEnvelope(response, 400, errorEnvelope('', 'INVALID_REQUEST', 'browser seam envelope is not valid JSON'))
      return
    }
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
      sendEnvelope(response, 400, errorEnvelope('', 'INVALID_REQUEST', 'browser seam envelope must be an object'))
      return
    }

    const correlationId = typeof envelope.correlation_id === 'string' ? envelope.correlation_id : ''
    if (correlationId.length === 0) {
      sendEnvelope(response, 400, errorEnvelope('', 'INVALID_REQUEST', 'browser seam correlation_id is required'))
      return
    }

    if (envelope.seam_protocol_version !== BROWSER_SEAM_PROTOCOL_VERSION) {
      sendEnvelope(
        response,
        409,
        errorEnvelope(correlationId, 'VERSION_MISMATCH', 'browser seam protocol version mismatch'),
      )
      return
    }

    const timeoutMs = envelope.deadline_ms
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      sendEnvelope(response, 400, errorEnvelope(correlationId, 'INVALID_REQUEST', 'browser seam deadline_ms is required'))
      return
    }

    const result = await dispatch(envelope, Math.floor(timeoutMs), port)
    sendEnvelope(response, 200, {
      seam_protocol_version: BROWSER_SEAM_PROTOCOL_VERSION,
      correlation_id: correlationId,
      outcome: 'ok',
      payload: result,
    })
  } catch (error) {
    const failure = toErrorBody(error)
    sendEnvelope(response, 200, {
      seam_protocol_version: BROWSER_SEAM_PROTOCOL_VERSION,
      correlation_id: '',
      outcome: 'error',
      error: failure,
    })
  }
}

async function dispatch(
  envelope: SeamRequestEnvelope,
  timeoutMs: number,
  port: BrowserAutomationPortV01,
): Promise<unknown> {
  switch (envelope.operation) {
    case 'healthCheck': {
      const health: BrowserAutomationHealth = await port.healthCheck(timeoutMs)
      return health
    }
    case 'observeConversation': {
      const input = readObservePayload(envelope.payload)
      const observation: ConversationObservation = await port.observeConversation(input, timeoutMs)
      return observation
    }
    case 'submitUserMessage': {
      const { input, idempotencyKey } = readSubmitPayload(envelope.payload)
      const receipt: UserMessageReceipt = await port.submitUserMessage(input, idempotencyKey, timeoutMs)
      return receipt
    }
    default:
      throw new BrowserAutomationPortError({
        code: 'INVALID_REQUEST',
        message: 'unsupported browser seam operation',
        retryable: false,
      })
  }
}

// ---------------------------------------------------------------------------
// Validation (fail closed; never guess a shape)
// ---------------------------------------------------------------------------

function readObservePayload(payload: unknown): { conversation_ref: ConversationRef; since_fingerprint?: string } {
  const record = requireRecord(payload, 'observeConversation payload')
  const conversationRef = readConversationRef(record.conversation_ref)
  const since = record.since_fingerprint
  if (since === undefined) return { conversation_ref: conversationRef }
  if (typeof since !== 'string' || since.length === 0) {
    throw invalid('observeConversation since_fingerprint must be a non-empty string when present')
  }
  return { conversation_ref: conversationRef, since_fingerprint: since }
}

function readSubmitPayload(payload: unknown): { input: SubmitUserMessageInput; idempotencyKey: string } {
  const record = requireRecord(payload, 'submitUserMessage payload')
  const conversationRef = readConversationRef(record.conversation_ref)
  const content = record.content
  if (typeof content !== 'string') {
    throw invalid('submitUserMessage content must be a string')
  }
  const approvalRef = requireRecord(record.approval_ref, 'submitUserMessage approval_ref')
  if (typeof approvalRef.kind !== 'string' || typeof approvalRef.ref !== 'string') {
    throw invalid('submitUserMessage approval_ref requires string kind and ref')
  }
  const idempotencyKey = record.idempotency_key
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    throw invalid('submitUserMessage idempotency_key is required')
  }
  const approval = approvalRef.hash === undefined
    ? { kind: approvalRef.kind, ref: approvalRef.ref }
    : { kind: approvalRef.kind, ref: approvalRef.ref, hash: approvalRef.hash as string }

  return {
    input: {
      conversation_ref: conversationRef,
      content,
      // Passed through untouched. This transport never decides whether the
      // business approval is valid — that gate stays in WorkbenchCore.
      approval_ref: approval,
    },
    idempotencyKey,
  }
}

function readConversationRef(value: unknown): ConversationRef {
  const record = requireRecord(value, 'conversation_ref')
  if (typeof record.adapter_id !== 'string' || record.adapter_id.length === 0) {
    throw invalid('conversation_ref.adapter_id must be a non-empty string')
  }
  if (typeof record.conversation_id !== 'string' || record.conversation_id.length === 0) {
    throw invalid('conversation_ref.conversation_id must be a non-empty string')
  }
  return { adapter_id: record.adapter_id, conversation_id: record.conversation_id }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function invalid(message: string): BrowserAutomationPortError {
  return new BrowserAutomationPortError({ code: 'INVALID_REQUEST', message, retryable: false })
}

// ---------------------------------------------------------------------------
// Transport plumbing
// ---------------------------------------------------------------------------

function isAuthorized(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string') return false
  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || typeof token !== 'string' || token.length === 0) return false
  const actualBuffer = Buffer.from(token)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(actualBuffer, expectedBuffer)
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buffer.length
    if (size > BROWSER_SEAM_MAX_BODY_BYTES) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function errorEnvelope(correlationId: string, code: string, message: string): SeamResponseEnvelope {
  return {
    seam_protocol_version: BROWSER_SEAM_PROTOCOL_VERSION,
    correlation_id: correlationId,
    outcome: 'error',
    error: { code, message, retryable: false },
  }
}

/**
 * Maps any failure into the frozen generic port error vocabulary. Non-port
 * failures collapse to a generic INTERNAL message so nothing internal
 * (page structure, targets, driver state) can leak across the seam.
 */
function toErrorBody(error: unknown): SeamErrorBody {
  if (error instanceof BrowserAutomationPortError) {
    return error.evidenceRef === undefined
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : { code: error.code, message: error.message, retryable: error.retryable, evidence_ref: error.evidenceRef }
  }
  return { code: 'INTERNAL', message: 'browser seam internal failure', retryable: false }
}

function sendEnvelope(response: ServerResponse, status: number, body: SeamResponseEnvelope): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    Connection: 'close',
  })
  response.end(payload)
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>(resolve => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
}
