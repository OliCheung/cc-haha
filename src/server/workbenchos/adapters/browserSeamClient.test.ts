/**
 * Offline tests for the BrowserAutomationPort seam client (M5-PRE-001D).
 *
 * A real loopback HTTP server stands in for the Electron-owned listener. No
 * Electron, no browser, no network outside 127.0.0.1.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserAutomationPortError } from '../ports/browserAutomationPort.js'
import {
  BROWSER_SEAM_CREDENTIAL_ENV,
  BROWSER_SEAM_PROTOCOL_VERSION,
  BROWSER_SEAM_URL_ENV,
  createBrowserSeamClient,
  createBrowserSeamPortFromEnv,
  resolveBrowserSeamConfig,
} from './browserSeamClient.js'

// Clearly-fake placeholder credential. Never a real secret.
const CREDENTIAL = 'seam-test-credential-not-a-real-secret'

const CONVERSATION = { adapter_id: 'chatgpt-web', conversation_id: 'conversation-1' }

type RecordedRequest = {
  method: string
  authorization: string | undefined
  body: Record<string, unknown>
}

type FakeServer = {
  url: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

const openServers: Server[] = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

async function startFakeServer(
  handler: (request: RecordedRequest, index: number) => { status: number; body: unknown } | 'never',
): Promise<FakeServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const raw = await readBody(request)
      let body: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>
        }
      } catch {
        body = {}
      }
      const recorded: RecordedRequest = {
        method: request.method ?? '',
        authorization: request.headers.authorization,
        body,
      }
      requests.push(recorded)
      const result = handler(recorded, requests.length - 1)
      if (result === 'never') return
      const payload = result.body === undefined ? '' : JSON.stringify(result.body)
      response.writeHead(result.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
      response.end(payload)
    })()
  })
  openServers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/internal/browser-automation`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function okEnvelope(request: RecordedRequest, payload: unknown): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      seam_protocol_version: BROWSER_SEAM_PROTOCOL_VERSION,
      correlation_id: request.body.correlation_id,
      outcome: 'ok',
      payload,
    },
  }
}

function errorEnvelope(
  request: RecordedRequest,
  code: string,
  message = 'reported failure',
): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      seam_protocol_version: BROWSER_SEAM_PROTOCOL_VERSION,
      correlation_id: request.body.correlation_id,
      outcome: 'error',
      error: { code, message, retryable: false },
    },
  }
}

function makeClient(server: FakeServer, overrides: { fetchFn?: typeof fetch } = {}) {
  let counter = 0
  const client = createBrowserSeamClient({
    baseUrl: server.url,
    credential: CREDENTIAL,
    nextCorrelationId: () => `corr-${++counter}`,
    ...(overrides.fetchFn === undefined ? {} : { fetchFn: overrides.fetchFn as never }),
  })
  return client
}

describe('browser seam client — envelope', () => {
  test('sends exactly one POST with the frozen envelope and the dedicated credential', async () => {
    const server = await startFakeServer(request => okEnvelope(request, {
      protocol_version: '0.1',
      available: true,
      capabilities: ['observe', 'submit'],
    }))
    const client = makeClient(server)

    const health = await client.healthCheck(4_000)

    expect(health.available).toBe(true)
    expect(server.requests).toHaveLength(1)
    const request = server.requests[0]!
    expect(request.method).toBe('POST')
    expect(request.authorization).toBe(`Bearer ${CREDENTIAL}`)
    expect(request.body.seam_protocol_version).toBe(BROWSER_SEAM_PROTOCOL_VERSION)
    expect(request.body.operation).toBe('healthCheck')
    expect(request.body.deadline_ms).toBe(4_000)
    expect(typeof request.body.correlation_id).toBe('string')
  })

  test('never derives the business key from the transport correlation id', async () => {
    const server = await startFakeServer(request => okEnvelope(request, {
      message_ref: 'chatgpt:user:u2',
      accepted_at: '2026-10-03T00:00:01.000Z',
      content_fingerprint: 'fp:u2',
    }))
    const client = makeClient(server)

    await client.submitUserMessage(
      { conversation_ref: CONVERSATION, content: 'hello', approval_ref: { kind: 'external_browser_submit', ref: 'a1' } },
      'business-key-1',
      3_000,
    )

    const body = server.requests[0]!.body
    const payload = body.payload as Record<string, unknown>
    expect(payload.idempotency_key).toBe('business-key-1')
    expect(payload.idempotency_key).not.toBe(body.correlation_id)
  })
})

describe('browser seam client — operations', () => {
  test('healthCheck round trip', async () => {
    const server = await startFakeServer(request => okEnvelope(request, {
      protocol_version: '0.1',
      available: false,
      capabilities: [],
      detail: 'unavailable',
    }))
    const client = makeClient(server)
    const health = await client.healthCheck(1_000)
    expect(health).toEqual({ protocol_version: '0.1', available: false, capabilities: [], detail: 'unavailable' })
  })

  test('observeConversation preserves conversation_ref, since_fingerprint and message identity', async () => {
    const messages = [
      { role: 'user', message_ref: 'chatgpt:user:u1', content: 'hello', content_fingerprint: 'fp:u1', settled: true },
      { role: 'assistant', message_ref: 'chatgpt:assistant:a1', content: 'hi', content_fingerprint: 'fp:a1', settled: false },
    ]
    const server = await startFakeServer(request => okEnvelope(request, {
      observed_at: '2026-10-03T00:00:00.000Z',
      conversation_fingerprint: 'cfp:abc',
      messages,
    }))
    const client = makeClient(server)

    const observation = await client.observeConversation(
      { conversation_ref: CONVERSATION, since_fingerprint: 'fp:u1' },
      2_000,
    )

    expect(observation.messages).toEqual(messages)
    const payload = server.requests[0]!.body.payload as Record<string, unknown>
    expect(payload.conversation_ref).toEqual(CONVERSATION)
    expect(payload.since_fingerprint).toBe('fp:u1')
  })

  test('submitUserMessage passes approval_ref through untouched and preserves the receipt', async () => {
    const server = await startFakeServer(request => okEnvelope(request, {
      message_ref: 'chatgpt:user:u2',
      accepted_at: '2026-10-03T00:00:01.000Z',
      content_fingerprint: 'fp:u2',
    }))
    const client = makeClient(server)
    const approvalRef = { kind: 'external_browser_submit', ref: 'a1', hash: 'fingerprint-1' }

    const receipt = await client.submitUserMessage(
      { conversation_ref: CONVERSATION, content: 'hello', approval_ref: approvalRef },
      'business-key-1',
      2_000,
    )

    expect(receipt.message_ref).toBe('chatgpt:user:u2')
    expect(receipt.content_fingerprint).toBe('fp:u2')
    const payload = server.requests[0]!.body.payload as Record<string, unknown>
    expect(payload.approval_ref).toEqual(approvalRef)
    expect(payload.conversation_ref).toEqual(CONVERSATION)
  })
})

describe('browser seam client — error mapping', () => {
  const codes = [
    'UNAVAILABLE',
    'TIMEOUT',
    'NOT_FOUND',
    'PERMISSION_REQUIRED',
    'INVALID_REQUEST',
    'IDEMPOTENCY_CONFLICT',
    'UNSUPPORTED_CAPABILITY',
    'VERSION_MISMATCH',
    'INTERNAL',
  ] as const

  for (const code of codes) {
    test(`preserves ${code} from the seam`, async () => {
      const server = await startFakeServer(request => errorEnvelope(request, code))
      const client = makeClient(server)
      const failure = await client.healthCheck(1_000).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(BrowserAutomationPortError)
      expect((failure as BrowserAutomationPortError).code).toBe(code)
      expect((failure as BrowserAutomationPortError).retryable).toBe(false)
    })
  }

  test('maps an orphaned non-JSON response to INTERNAL', async () => {
    const server = await startFakeServer(() => ({ status: 502, body: undefined }))
    const client = makeClient(server)
    const failure = await client.healthCheck(1_000).catch((error: unknown) => error)
    expect((failure as BrowserAutomationPortError).code).toBe('INTERNAL')
  })

  test('maps an authentication rejection to UNAVAILABLE, never to PERMISSION_REQUIRED', async () => {
    const server = await startFakeServer(() => ({
      status: 401,
      body: {
        seam_protocol_version: BROWSER_SEAM_PROTOCOL_VERSION,
        correlation_id: '',
        outcome: 'error',
        error: { code: 'UNAVAILABLE', message: 'browser seam caller is not authorized', retryable: false },
      },
    }))
    const client = makeClient(server)
    const failure = await client.healthCheck(1_000).catch((error: unknown) => error)
    expect((failure as BrowserAutomationPortError).code).toBe('UNAVAILABLE')
    expect((failure as BrowserAutomationPortError).code).not.toBe('PERMISSION_REQUIRED')
  })

  test('rejects a version mismatch and a correlation mismatch', async () => {
    const versionServer = await startFakeServer(request => ({
      status: 200,
      body: {
        seam_protocol_version: '0.2',
        correlation_id: request.body.correlation_id,
        outcome: 'ok',
        payload: {},
      },
    }))
    const versionFailure = await makeClient(versionServer).healthCheck(1_000).catch((error: unknown) => error)
    expect((versionFailure as BrowserAutomationPortError).code).toBe('VERSION_MISMATCH')

    const correlationServer = await startFakeServer(() => ({
      status: 200,
      body: {
        seam_protocol_version: BROWSER_SEAM_PROTOCOL_VERSION,
        correlation_id: 'someone-elses-correlation',
        outcome: 'ok',
        payload: {},
      },
    }))
    const correlationFailure = await makeClient(correlationServer).healthCheck(1_000).catch((error: unknown) => error)
    expect((correlationFailure as BrowserAutomationPortError).code).toBe('INTERNAL')
  })

  test('rejects a malformed success payload', async () => {
    const server = await startFakeServer(request => okEnvelope(request, { available: 'yes', capabilities: [] }))
    const client = makeClient(server)
    const failure = await client.healthCheck(1_000).catch((error: unknown) => error)
    expect((failure as BrowserAutomationPortError).code).toBe('INTERNAL')
  })
})

describe('browser seam client — retry / recovery semantics', () => {
  test('a timed-out call is reported as TIMEOUT and is attempted exactly once', async () => {
    const server = await startFakeServer(() => 'never')
    const client = makeClient(server)
    const failure = await client.submitUserMessage(
      { conversation_ref: CONVERSATION, content: 'hello', approval_ref: { kind: 'external_browser_submit', ref: 'a1' } },
      'business-key-1',
      60,
    ).catch((error: unknown) => error)

    expect((failure as BrowserAutomationPortError).code).toBe('TIMEOUT')
    expect(server.requests).toHaveLength(1)
  })

  test('a lost response never triggers a second submit', async () => {
    const server = await startFakeServer(() => 'never')
    let attempts = 0
    const countingFetch: typeof fetch = async (...args) => {
      attempts += 1
      return await fetch(...args)
    }
    const client = makeClient(server, { fetchFn: countingFetch })
    await client.submitUserMessage(
      { conversation_ref: CONVERSATION, content: 'hello', approval_ref: { kind: 'external_browser_submit', ref: 'a1' } },
      'business-key-1',
      60,
    ).catch(() => undefined)

    expect(attempts).toBe(1)
    expect(server.requests).toHaveLength(1)
  })

  test('an unreachable endpoint maps to UNAVAILABLE after a single attempt', async () => {
    const server = await startFakeServer(request => okEnvelope(request, {}))
    const url = server.url
    await server.close()

    let attempts = 0
    const countingFetch: typeof fetch = async (...args) => {
      attempts += 1
      return await fetch(...args)
    }
    const client = createBrowserSeamClient({
      baseUrl: url,
      credential: CREDENTIAL,
      fetchFn: countingFetch as never,
      nextCorrelationId: () => 'corr-1',
    })
    const failure = await client.healthCheck(500).catch((error: unknown) => error)
    expect((failure as BrowserAutomationPortError).code).toBe('UNAVAILABLE')
    expect(attempts).toBe(1)
  })

  test('read-only operations are not retried behind the caller either', async () => {
    const server = await startFakeServer(() => 'never')
    let attempts = 0
    const countingFetch: typeof fetch = async (...args) => {
      attempts += 1
      return await fetch(...args)
    }
    const client = makeClient(server, { fetchFn: countingFetch })
    await client.observeConversation({ conversation_ref: CONVERSATION }, 60).catch(() => undefined)
    expect(attempts).toBe(1)
    expect(server.requests).toHaveLength(1)
  })
})

describe('browser seam client — environment composition', () => {
  test('resolves configuration only when both endpoint and credential are present', () => {
    expect(resolveBrowserSeamConfig({})).toBeNull()
    expect(resolveBrowserSeamConfig({ [BROWSER_SEAM_URL_ENV]: 'http://127.0.0.1:1/internal/browser-automation' })).toBeNull()
    expect(resolveBrowserSeamConfig({ [BROWSER_SEAM_CREDENTIAL_ENV]: 'abc' })).toBeNull()
    expect(resolveBrowserSeamConfig({
      [BROWSER_SEAM_URL_ENV]: 'http://127.0.0.1:1/internal/browser-automation',
      [BROWSER_SEAM_CREDENTIAL_ENV]: 'abc',
    })).toEqual({ baseUrl: 'http://127.0.0.1:1/internal/browser-automation', credential: 'abc' })
  })

  test.each([
    'https://127.0.0.1:1/internal/browser-automation',
    'http://example.com/internal/browser-automation',
    'http://127.0.0.1:1/other-route',
    'http://user:pass@127.0.0.1:1/internal/browser-automation',
  ])('refuses an unsafe configured endpoint: %s', url => {
    expect(resolveBrowserSeamConfig({
      [BROWSER_SEAM_URL_ENV]: url,
      [BROWSER_SEAM_CREDENTIAL_ENV]: 'abc',
    })).toBeNull()
  })

  test('refuses direct client construction with an unsafe endpoint', () => {
    expect(() => createBrowserSeamClient({
      baseUrl: 'https://example.com/internal/browser-automation',
      credential: CREDENTIAL,
    })).toThrow(/loopback endpoint/)
  })

  test('builds no port when the seam is not configured (fail closed)', () => {
    expect(createBrowserSeamPortFromEnv({})).toBeNull()
  })

  test('builds a port from a configured environment', async () => {
    const server = await startFakeServer(request => okEnvelope(request, {
      protocol_version: '0.1',
      available: true,
      capabilities: ['observe'],
    }))
    const port = createBrowserSeamPortFromEnv({
      [BROWSER_SEAM_URL_ENV]: server.url,
      [BROWSER_SEAM_CREDENTIAL_ENV]: CREDENTIAL,
    })
    expect(port).not.toBeNull()
    const health = await port!.healthCheck(1_000)
    expect(health.capabilities).toEqual(['observe'])
    expect(server.requests[0]!.authorization).toBe(`Bearer ${CREDENTIAL}`)
  })
})
