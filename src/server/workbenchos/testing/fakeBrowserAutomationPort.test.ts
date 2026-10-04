/**
 * Tests for FakeBrowserAutomationPort and the FROZEN v0.1 contract semantics.
 *
 * No timers, no real clock, no network, no Chrome. Pure deterministic state.
 * Authorized by task package M4-02A.
 */

import { describe, expect, test } from 'bun:test'
import {
  FakeBrowserAutomationPort,
  type FakeBrowserSubmitMode,
} from './fakeBrowserAutomationPort.js'
import type { BrowserAutomationPortV01, ConversationRef } from '../ports/browserAutomationPort.js'
import { BrowserAutomationPortError } from '../ports/browserAutomationPort.js'

const REF: ConversationRef = { adapter_id: 'chatgpt-web', conversation_id: 'conv-1' }

function assertImplementsPort(_value: BrowserAutomationPortV01): void {}

describe('FakeBrowserAutomationPort — structural', () => {
  test('implements the frozen BrowserAutomationPortV01 interface', () => {
    const fake = new FakeBrowserAutomationPort()
    assertImplementsPort(fake)
    expect(fake.protocolVersion).toBe('0.1')
  })
})

describe('health', () => {
  test('success returns available with capability', async () => {
    const fake = new FakeBrowserAutomationPort({ capability: 'fake-browser' })
    const health = await fake.healthCheck(1000)
    expect(health.available).toBe(true)
    expect(health.protocol_version).toBe('0.1')
    expect(health.capabilities).toContain('fake-browser')
  })

  test('health_unavailable fault throws UNAVAILABLE (no crash, fail-closed)', async () => {
    const fake = new FakeBrowserAutomationPort()
    fake.injectFault('health_unavailable')
    await expect(fake.healthCheck(1000)).rejects.toBeInstanceOf(BrowserAutomationPortError)
    await expect(fake.healthCheck(1000)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      retryable: false,
    })
  })
})

describe('observeConversation', () => {
  test('empty conversation yields no messages but a stable fingerprint', async () => {
    const fake = new FakeBrowserAutomationPort()
    const obs = await fake.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages).toEqual([])
    expect(obs.conversation_fingerprint).toMatch(/^cfp:/)
  })

  test('user and assistant messages are observed with roles', async () => {
    const fake = new FakeBrowserAutomationPort()
    fake.addUserMessage(REF, 'hello from user')
    fake.addAssistantMessage(REF, 'hello from assistant', true)
    const obs = await fake.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages).toHaveLength(2)
    expect(obs.messages[0].role).toBe('user')
    expect(obs.messages[1].role).toBe('assistant')
    expect(obs.messages[0].settled).toBe(true)
  })

  test('in-flight assistant stream reports settled=false, then settled=true after mark', async () => {
    const fake = new FakeBrowserAutomationPort()
    const ref = fake.addAssistantMessage(REF, 'thinking...', false)
    const before = await fake.observeConversation({ conversation_ref: REF }, 1000)
    expect(before.messages[0].settled).toBe(false)

    fake.markAssistantSettled(ref)
    const after = await fake.observeConversation({ conversation_ref: REF }, 1000)
    expect(after.messages[0].settled).toBe(true)
  })

  test('since_fingerprint filters to messages after the marker', async () => {
    const fake = new FakeBrowserAutomationPort()
    fake.addUserMessage(REF, 'first')
    fake.addUserMessage(REF, 'second')
    const obs = await fake.observeConversation(
      { conversation_ref: REF, since_fingerprint: `fp:${hashOf('first')}` },
      1000,
    )
    // 'first' has the marker fingerprint, so only 'second' remains.
    expect(obs.messages).toHaveLength(1)
    expect(obs.messages[0].content).toBe('second')
  })

  test('observe faults inject UNAVAILABLE / NOT_FOUND / TIMEOUT', async () => {
    const fake = new FakeBrowserAutomationPort()
    fake.injectFault('observe_unavailable')
    await expect(fake.observeConversation({ conversation_ref: REF }, 1000)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    fake.clearFaults()

    fake.injectFault('observe_not_found')
    await expect(fake.observeConversation({ conversation_ref: REF }, 1000)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    fake.clearFaults()

    fake.injectFault('observe_timeout')
    await expect(fake.observeConversation({ conversation_ref: REF }, 1000)).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
  })
})

describe('submitUserMessage', () => {
  test('success appends a user message and returns a receipt with fingerprint', async () => {
    const fake = new FakeBrowserAutomationPort()
    const receipt = await fake.submitUserMessage(
      { conversation_ref: REF, content: 'do the thing', approval_ref: { kind: 'approval', ref: 'apr-1' } },
      'op-1',
      1000,
    )
    expect(receipt.message_ref).toMatch(/^msg-/)
    expect(receipt.content_fingerprint).toBe(`fp:${hashOf('do the thing')}`)

    const obs = await fake.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages).toHaveLength(1)
    expect(obs.messages[0].role).toBe('user')
    expect(obs.messages[0].content).toBe('do the thing')
    expect(fake.getSendCount()).toBe(1)
  })

  test('same idempotencyKey returns the same receipt without resending', async () => {
    const fake = new FakeBrowserAutomationPort()
    const input = {
      conversation_ref: REF,
      content: 'repeat',
      approval_ref: { kind: 'approval', ref: 'apr-1' } as const,
    }
    const r1 = await fake.submitUserMessage(input, 'op-dup', 1000)
    const r2 = await fake.submitUserMessage(input, 'op-dup', 1000)
    expect(r2.message_ref).toBe(r1.message_ref)
    expect(r2.content_fingerprint).toBe(r1.content_fingerprint)
    expect(fake.getSendCount()).toBe(1)
    const obs = await fake.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages.filter(m => m.role === 'user')).toHaveLength(1)
  })

  test('crash/recovery: effect happened, ack lost, recovery does NOT resend', async () => {
    const fake = new FakeBrowserAutomationPort()
    const input = {
      conversation_ref: REF,
      content: 'crashy',
      approval_ref: { kind: 'approval', ref: 'apr-1' } as const,
    }

    fake.setNextSubmitMode('effect_then_lost_ack')
    await expect(fake.submitUserMessage(input, 'op-crash', 1000)).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
    // The user message was appended despite the lost ack.
    expect(fake.getSendCount()).toBe(1)
    let obs = await fake.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages.filter(m => m.role === 'user')).toHaveLength(1)

    // Recovery with the SAME key: content_fingerprint lookup finds the existing
    // user message and returns its receipt — no second send.
    const recovered = await fake.submitUserMessage(input, 'op-crash', 1000)
    expect(recovered.content_fingerprint).toBe(`fp:${hashOf('crashy')}`)
    expect(fake.getSendCount()).toBe(1)
    obs = await fake.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages.filter(m => m.role === 'user')).toHaveLength(1)
  })

  test('different idempotencyKey + same content CAN be sent again (not a global ban)', async () => {
    const fake = new FakeBrowserAutomationPort()
    const base = {
      conversation_ref: REF,
      content: 'identical text',
      approval_ref: { kind: 'approval', ref: 'apr-1' } as const,
    }
    await fake.submitUserMessage(base, 'op-a', 1000)
    await fake.submitUserMessage(base, 'op-b', 1000)
    expect(fake.getSendCount()).toBe(2)
    const obs = await fake.observeConversation({ conversation_ref: REF }, 1000)
    const users = obs.messages.filter(m => m.role === 'user')
    expect(users).toHaveLength(2)
    expect(users[0].content).toBe('identical text')
    expect(users[1].content).toBe('identical text')
  })

  const FAILURE_MODES: Array<[FakeBrowserSubmitMode, string]> = [
    ['permission', 'PERMISSION_REQUIRED'],
    ['unavailable', 'UNAVAILABLE'],
    ['not_found', 'NOT_FOUND'],
    ['timeout', 'TIMEOUT'],
    ['idempotency_conflict', 'IDEMPOTENCY_CONFLICT'],
  ]

  test.each(FAILURE_MODES)('submit failure mode %s throws %s with no send', async (mode, code) => {
    const fake = new FakeBrowserAutomationPort()
    fake.setNextSubmitMode(mode)
    await expect(
      fake.submitUserMessage(
        { conversation_ref: REF, content: 'x', approval_ref: { kind: 'approval', ref: 'apr-1' } },
        'op-fail',
        1000,
      ),
    ).rejects.toMatchObject({ code, retryable: expect.any(Boolean) })
    expect(fake.getSendCount()).toBe(0)
  })
})

describe('M4-01-ID message identity contract (Fake)', () => {
  test('same message observed repeatedly yields the same message_ref', async () => {
    const fake = new FakeBrowserAutomationPort()
    const r = fake.addUserMessage(REF, 'stable')
    const o1 = await fake.observeConversation({ conversation_ref: REF }, 1000)
    const o2 = await fake.observeConversation({ conversation_ref: REF }, 1000)
    expect(o1.messages[0].message_ref).toBe(r)
    expect(o2.messages[0].message_ref).toBe(r)
  })

  test('two messages with IDENTICAL content yield different message_refs', async () => {
    const fake = new FakeBrowserAutomationPort()
    const r1 = fake.addUserMessage(REF, 'same')
    const r2 = fake.addUserMessage(REF, 'same')
    expect(r1).not.toBe(r2)
    const obs = await fake.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages[0].content).toBe(obs.messages[1].content)
    expect(obs.messages[0].message_ref).not.toBe(obs.messages[1].message_ref)
  })

  test('submit receipt message_ref matches the later-observed message_ref', async () => {
    const fake = new FakeBrowserAutomationPort()
    const receipt = await fake.submitUserMessage(
      { conversation_ref: REF, content: 'do the thing', approval_ref: { kind: 'approval', ref: 'apr-1' } },
      'op-ref',
      1000,
    )
    const obs = await fake.observeConversation({ conversation_ref: REF }, 1000)
    const landed = obs.messages.find(m => m.role === 'user' && m.content === 'do the thing')
    expect(landed).toBeDefined()
    expect(landed!.message_ref).toBe(receipt.message_ref)
  })

  test('since_fingerprint does not alter a message_ref', async () => {
    const fake = new FakeBrowserAutomationPort()
    fake.addUserMessage(REF, 'a')
    fake.addUserMessage(REF, 'b')
    const rc = fake.addUserMessage(REF, 'c')
    const all = await fake.observeConversation({ conversation_ref: REF }, 1000)
    const refCAll = all.messages[2].message_ref
    const marker = all.messages[1].content_fingerprint
    const since = await fake.observeConversation(
      { conversation_ref: REF, since_fingerprint: marker },
      1000,
    )
    expect(since.messages).toHaveLength(1)
    expect(since.messages[0].content).toBe('c')
    expect(since.messages[0].message_ref).toBe(rc)
    expect(since.messages[0].message_ref).toBe(refCAll)
  })

  test('message_ref is stable as the conversation grows (not position-derived)', async () => {
    const fake = new FakeBrowserAutomationPort()
    const rx = fake.addUserMessage(REF, 'x')
    fake.addUserMessage(REF, 'y')
    const before = await fake.observeConversation({ conversation_ref: REF }, 1000)
    const refXBefore = before.messages.find(m => m.content === 'x')!.message_ref
    fake.addUserMessage(REF, 'z') // grow the conversation
    const after = await fake.observeConversation({ conversation_ref: REF }, 1000)
    const refXAfter = after.messages.find(m => m.content === 'x')!.message_ref
    expect(refXAfter).toBe(refXBefore)
    expect(refXAfter).toBe(rx)
  })
})

// Local mirror of the fake's fingerprint algorithm so tests can assert on it
// without reaching into adapter internals.
function hashOf(content: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < content.length; i += 1) {
    h ^= content.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}
