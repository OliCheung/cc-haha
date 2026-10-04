/**
 * Offline tests for the Browser Seam listener (M5-PRE-001D).
 *
 * Real loopback HTTP, scriptable fake port. No Electron, no Chrome, no network
 * outside 127.0.0.1.
 */

import { describe, expect, test } from 'bun:test'
import type {
  BrowserAutomationHealth,
  BrowserAutomationPortV01,
  ConversationObservation,
  ConversationRef,
  SubmitUserMessageInput,
  UserMessageReceipt,
} from '../../../src/server/workbenchos/ports/browserAutomationPort.js'
import { BrowserAutomationPortError } from '../../../src/server/workbenchos/ports/browserAutomationPort.js'
import {
  BROWSER_SEAM_PATH,
  BROWSER_SEAM_PROTOCOL_VERSION,
  createBrowserSeamServer,
  type BrowserSeamServer,
} from './seamServer.js'

// Clearly-fake placeholder credential. Never a real secret.
const CREDENTIAL = 'seam-test-credential-not-a-real-secret'

const CONVERSATION: ConversationRef = { adapter_id: 'chatgpt-web', conversation_id: 'conversation-1' }

class FakePort implements BrowserAutomationPortV01 {
  readonly protocolVersion = '0.1' as const
  healthCalls = 0
  observeCalls = 0
  submitCalls = 0
  lastObserve: { conversation_ref: ConversationRef; since_fingerprint?: string } | null = null
  lastSubmit: { input: SubmitUserMessageInput; idempotencyKey: string; timeoutMs: number } | null = null
  lastTimeoutMs = 0
  failure: Error | null = null

  health: BrowserAutomationHealth = {
    protocol_version: '0.1',
    available: true,
    capabilities: ['observe', 'submit'],
  }

  observation: ConversationObservation = {
    observed_at: '2026-10-03T00:00:00.000Z',
    conversation_fingerprint: 'cfp:abc',
    messages: [
      { role: 'user', message_ref: 'chatgpt:user:u1', content: 'hello', content_fingerprint: 'fp:u1', settled: true },
      { role: 'assistant', message_ref: 'chatgpt:assistant:a1', content: 'hi', content_fingerprint: 'fp:a1', settled: true },
    ],
  }

  receipt: UserMessageReceipt = {
    message_ref: 'chatgpt:user:u2',
    accepted_at: '2026-10-03T00:00:01.000Z',
    content_fingerprint: 'fp:u2',
  }

  async healthCheck(timeoutMs: number): Promise<BrowserAutomationHealth> {
    this.healthCalls += 1
    this.lastTimeoutMs = timeoutMs
    if (this.failure) throw this.failure
    return this.health
  }

  async observeConversation(
    input: { conversation_ref: ConversationRef; since_fingerprint?: string },
    timeoutMs: number,
  ): Promise<ConversationObservation> {
    this.observeCalls += 1
    this.lastTimeoutMs = timeoutMs
    this.lastObserve = input
    if (this.failure) throw this.failure
    return this.observation
  }

  async submitUserMessage(
    input: SubmitUserMessageInput,
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<UserMessageReceipt> {
    this.submitCalls += 1
    this.lastTimeoutMs = timeoutMs
    this.lastSubmit = { input, idempotencyKey, timeoutMs }
    if (this.failure) throw this.failure
    return this.receipt
  }
}

async function startServer(port: BrowserAutomationPortV01): Promise<BrowserSeamServer> {
  return await createBrowserSeamServer({ port, credential: CREDENTIAL })
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seam_protocol_version: BROWSER_SEAM_PROTOCOL_VERSION,
    correlation_id: 'corr-1',
    operation: 'healthCheck',
    deadline_ms: 5_000,
    payload: {},
    ...overrides,
  }
}

async function post(
  server: BrowserSeamServer,
  body: unknown,
  options: { credential?: string | null; method?: string; path?: string; raw?: string } = {},
): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  const url = options.path === undefined
    ? server.url
    : `http://${server.host}:${server.port}${options.path}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const credential = options.credential === undefined ? CREDENTIAL : options.credential
  if (credential !== null) headers.Authorization = `Bearer ${credential}`
  const response = await fetch(url, {
    method: options.method ?? 'POST',
    headers,
    body: options.method === 'GET' ? undefined : (options.raw ?? JSON.stringify(body)),
  })
  const text = await response.text()
  let json: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      json = parsed as Record<string, unknown>
    }
  } catch {
    json = null
  }
  return { status: response.status, text, json }
}

function errorCode(body: Record<string, unknown> | null): unknown {
  const error = body?.error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return undefined
  return (error as Record<string, unknown>).code
}

describe('browser seam listener — transport', () => {
  test('binds only 127.0.0.1 and exposes the single internal endpoint', async () => {
    const server = await startServer(new FakePort())
    try {
      expect(server.host).toBe('127.0.0.1')
      expect(server.url.startsWith(`http://127.0.0.1:${server.port}${BROWSER_SEAM_PATH}`)).toBe(true)
    } finally {
      await server.close()
    }
  })

  test('accepts POST and echoes the correlation id', async () => {
    const server = await startServer(new FakePort())
    try {
      const response = await post(server, envelope({ correlation_id: 'corr-health' }))
      expect(response.status).toBe(200)
      expect(response.json?.outcome).toBe('ok')
      expect(response.json?.correlation_id).toBe('corr-health')
      expect(response.json?.seam_protocol_version).toBe(BROWSER_SEAM_PROTOCOL_VERSION)
    } finally {
      await server.close()
    }
  })

  test('rejects unsupported methods', async () => {
    const server = await startServer(new FakePort())
    try {
      const response = await post(server, envelope(), { method: 'GET' })
      expect(response.status).toBe(405)
    } finally {
      await server.close()
    }
  })

  test('rejects unknown routes', async () => {
    const server = await startServer(new FakePort())
    try {
      const response = await post(server, envelope(), { path: '/health/browser' })
      expect(response.status).toBe(404)
      expect(errorCode(response.json)).toBe('INVALID_REQUEST')
    } finally {
      await server.close()
    }
  })

  test('rejects malformed envelopes and missing required fields', async () => {
    const server = await startServer(new FakePort())
    try {
      const malformed = await post(server, envelope(), { raw: '{not json' })
      expect(malformed.status).toBe(400)
      expect(errorCode(malformed.json)).toBe('INVALID_REQUEST')

      const missingCorrelation = await post(server, envelope({ correlation_id: undefined }))
      expect(missingCorrelation.status).toBe(400)
      expect(errorCode(missingCorrelation.json)).toBe('INVALID_REQUEST')

      const missingDeadline = await post(server, envelope({ deadline_ms: undefined }))
      expect(missingDeadline.status).toBe(400)
      expect(errorCode(missingDeadline.json)).toBe('INVALID_REQUEST')

      const unknownOperation = await post(server, envelope({ operation: 'execute' }))
      expect(unknownOperation.status).toBe(200)
      expect(unknownOperation.json?.outcome).toBe('error')
      expect(errorCode(unknownOperation.json)).toBe('INVALID_REQUEST')
    } finally {
      await server.close()
    }
  })

  test('rejects a protocol version mismatch', async () => {
    const server = await startServer(new FakePort())
    try {
      const response = await post(server, envelope({ seam_protocol_version: '0.2' }))
      expect(response.status).toBe(409)
      expect(errorCode(response.json)).toBe('VERSION_MISMATCH')
    } finally {
      await server.close()
    }
  })
})

describe('browser seam listener — authentication', () => {
  test('accepts the dedicated credential', async () => {
    const port = new FakePort()
    const server = await startServer(port)
    try {
      const response = await post(server, envelope())
      expect(response.status).toBe(200)
      expect(port.healthCalls).toBe(1)
    } finally {
      await server.close()
    }
  })

  test('rejects a missing or wrong credential without touching the port', async () => {
    const port = new FakePort()
    const server = await startServer(port)
    try {
      const missing = await post(server, envelope(), { credential: null })
      expect(missing.status).toBe(401)

      const wrong = await post(server, envelope(), { credential: 'seam-test-wrong-credential' })
      expect(wrong.status).toBe(401)

      expect(port.healthCalls).toBe(0)
    } finally {
      await server.close()
    }
  })

  test('never reports an authentication failure as a business approval failure', async () => {
    const server = await startServer(new FakePort())
    try {
      const response = await post(server, envelope(), { credential: null })
      expect(errorCode(response.json)).toBe('UNAVAILABLE')
      expect(errorCode(response.json)).not.toBe('PERMISSION_REQUIRED')
    } finally {
      await server.close()
    }
  })

  test('never echoes the credential back to the caller', async () => {
    const server = await startServer(new FakePort())
    try {
      const ok = await post(server, envelope())
      expect(ok.text).not.toContain(CREDENTIAL)

      const unauthorized = await post(server, envelope(), { credential: null })
      expect(unauthorized.text).not.toContain(CREDENTIAL)

      const wrong = await post(server, envelope(), { credential: CREDENTIAL })
      expect(wrong.text).not.toContain('seam-test-wrong-credential')
    } finally {
      await server.close()
    }
  })
})

describe('browser seam listener — operations', () => {
  test('healthCheck round trip', async () => {
    const port = new FakePort()
    const server = await startServer(port)
    try {
      const response = await post(server, envelope({ operation: 'healthCheck', deadline_ms: 1_234 }))
      expect(response.json?.outcome).toBe('ok')
      expect(response.json?.payload).toEqual({
        protocol_version: '0.1',
        available: true,
        capabilities: ['observe', 'submit'],
      })
      expect(port.lastTimeoutMs).toBe(1_234)
    } finally {
      await server.close()
    }
  })

  test('observeConversation preserves conversation_ref and message identity', async () => {
    const port = new FakePort()
    const server = await startServer(port)
    try {
      const response = await post(server, envelope({
        operation: 'observeConversation',
        payload: { conversation_ref: CONVERSATION, since_fingerprint: 'fp:u1' },
      }))
      expect(response.json?.outcome).toBe('ok')
      const payload = response.json?.payload as ConversationObservation
      expect(payload.conversation_fingerprint).toBe('cfp:abc')
      expect(payload.messages).toEqual(port.observation.messages)
      expect(payload.messages[1]!.message_ref).toBe('chatgpt:assistant:a1')
      expect(port.lastObserve).toEqual({ conversation_ref: CONVERSATION, since_fingerprint: 'fp:u1' })
    } finally {
      await server.close()
    }
  })

  test('submitUserMessage preserves approval_ref, receipt identity and the business key', async () => {
    const port = new FakePort()
    const server = await startServer(port)
    try {
      const approvalRef = { kind: 'external_browser_submit', ref: 'approval-1', hash: 'fingerprint-1' }
      const response = await post(server, envelope({
        operation: 'submitUserMessage',
        payload: {
          conversation_ref: CONVERSATION,
          content: 'hello',
          approval_ref: approvalRef,
          idempotency_key: 'business-key-1',
        },
      }))
      expect(response.json?.outcome).toBe('ok')
      const receipt = response.json?.payload as UserMessageReceipt
      expect(receipt.message_ref).toBe('chatgpt:user:u2')
      expect(receipt.content_fingerprint).toBe('fp:u2')
      expect(port.lastSubmit?.input.approval_ref).toEqual(approvalRef)
      expect(port.lastSubmit?.input.conversation_ref).toEqual(CONVERSATION)
      // The business operation key travels as its own field, never derived from
      // the transport correlation id.
      expect(port.lastSubmit?.idempotencyKey).toBe('business-key-1')
    } finally {
      await server.close()
    }
  })

  test('rejects a submit without an idempotency key or approval_ref', async () => {
    const port = new FakePort()
    const server = await startServer(port)
    try {
      const response = await post(server, envelope({
        operation: 'submitUserMessage',
        payload: { conversation_ref: CONVERSATION, content: 'hello' },
      }))
      expect(response.json?.outcome).toBe('error')
      expect(errorCode(response.json)).toBe('INVALID_REQUEST')
      expect(port.submitCalls).toBe(0)
    } finally {
      await server.close()
    }
  })
})

describe('browser seam listener — error mapping', () => {
  const cases = ['UNAVAILABLE', 'TIMEOUT', 'NOT_FOUND', 'PERMISSION_REQUIRED', 'INVALID_REQUEST'] as const

  for (const code of cases) {
    test(`preserves ${code} from the port`, async () => {
      const port = new FakePort()
      port.failure = new BrowserAutomationPortError({ code, message: `port said ${code}`, retryable: false })
      const server = await startServer(port)
      try {
        const response = await post(server, envelope({ operation: 'healthCheck' }))
        expect(response.json?.outcome).toBe('error')
        expect(errorCode(response.json)).toBe(code)
      } finally {
        await server.close()
      }
    })
  }

  test('maps an unclassifiable failure to INTERNAL without leaking its message', async () => {
    const port = new FakePort()
    port.failure = new Error('internal detail that must not cross the seam')
    const server = await startServer(port)
    try {
      const response = await post(server, envelope({ operation: 'healthCheck' }))
      expect(response.json?.outcome).toBe('error')
      expect(errorCode(response.json)).toBe('INTERNAL')
      expect(response.text).not.toContain('internal detail that must not cross the seam')
    } finally {
      await server.close()
    }
  })
})

describe('browser seam listener — critical recovery behavior', () => {
  test('a submit timeout results in exactly one submit call (no transport resend)', async () => {
    const port = new FakePort()
    port.failure = new BrowserAutomationPortError({
      code: 'TIMEOUT',
      message: 'browser operation timed out',
      retryable: false,
    })
    const server = await startServer(port)
    try {
      const response = await post(server, envelope({
        operation: 'submitUserMessage',
        payload: {
          conversation_ref: CONVERSATION,
          content: 'hello',
          approval_ref: { kind: 'external_browser_submit', ref: 'approval-1' },
          idempotency_key: 'business-key-1',
        },
      }))
      expect(errorCode(response.json)).toBe('TIMEOUT')
      expect(port.submitCalls).toBe(1)
    } finally {
      await server.close()
    }
  })

  test('a lost response leaves the operation unknown but never triggers a second submit', async () => {
    const port = new FakePort()
    const server = await startServer(port)
    try {
      // Client-side abandonment: the server keeps working, the caller never
      // learns the outcome. The seam must not compensate by resending.
      const controller = new AbortController()
      const request = fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CREDENTIAL}` },
        body: JSON.stringify(envelope({
          operation: 'submitUserMessage',
          payload: {
            conversation_ref: CONVERSATION,
            content: 'hello',
            approval_ref: { kind: 'external_browser_submit', ref: 'approval-1' },
            idempotency_key: 'business-key-1',
          },
        })),
        signal: controller.signal,
      }).catch(() => null)
      controller.abort()
      await request
      expect(port.submitCalls).toBeLessThanOrEqual(1)
    } finally {
      await server.close()
    }
  })
})

describe('browser seam listener — lifecycle', () => {
  test('close() stops accepting connections and is idempotent', async () => {
    const server = await startServer(new FakePort())
    await server.close()
    await server.close()

    let failed = false
    try {
      await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CREDENTIAL}` },
        body: JSON.stringify(envelope()),
      })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })

  test('a restarted listener gets a new endpoint but the same client contract', async () => {
    const first = await startServer(new FakePort())
    const firstUrl = first.url
    await first.close()

    const second = await startServer(new FakePort())
    try {
      expect(second.host).toBe('127.0.0.1')
      const response = await post(second, envelope({ correlation_id: 'corr-after-restart' }))
      expect(response.json?.outcome).toBe('ok')
      expect(response.json?.correlation_id).toBe('corr-after-restart')
      expect(second.url).not.toBe(firstUrl)
    } finally {
      await second.close()
    }
  })
})
