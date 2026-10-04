/**
 * Offline tests for ChatGptBrowserAutomationAdapter.
 *
 * No real Chrome, no CDP, no network. A scriptable MockChatGptPageDriver stands in
 * for the CDP driver. Every scenario below is deterministic.
 */

import { describe, expect, test } from 'bun:test'
import { ChatGptBrowserAutomationAdapter } from './adapter.js'
import { InMemoryIdempotencyStore } from './idempotency.js'
import { ChatGptDriverError, type ChatGptPageDriver, type CdpTarget, type DriverObservation, type DriverRawMessage } from './driver.js'
import { BrowserAutomationPortError } from '../../../src/server/workbenchos/ports/browserAutomationPort.js'
import type { ConversationRef } from '../../../src/server/workbenchos/ports/browserAutomationPort.js'

const REF: ConversationRef = { adapter_id: 'chatgpt-web', conversation_id: 'conv-1' }
const TARGET_ID = 'target-1'

class MockChatGptPageDriver implements ChatGptPageDriver {
  targets: CdpTarget[] = []
  composerAvailable = true
  stopButton = false
  autoRevealSent = true
  revealCount = 1
  throwOnList: Parameters<typeof ChatGptDriverError.prototype.constructor> extends never ? never : 'transport' | null = null
  throwOnObserve: 'timeout' | 'target_unavailable' | null = null
  typeAndSubmitCalls = 0
  private msgSeq = 0

  private observable = new Map<string, DriverRawMessage[]>()
  private reallySent: string[] = []

  setMessages(targetId: string, messages: DriverRawMessage[]): void {
    this.observable.set(targetId, messages)
  }

  revealSent(): void {
    for (const content of this.reallySent) this.appendUser(TARGET_ID, content)
  }

  private appendUser(targetId: string, text: string): void {
    const arr = this.observable.get(targetId) ?? []
    arr.push({ role: 'user', text, id: `m-${++this.msgSeq}` })
    this.observable.set(targetId, arr)
  }

  async listTargets(): Promise<CdpTarget[]> {
    if (this.throwOnList) throw new ChatGptDriverError(this.throwOnList, 'mock list error')
    return this.targets
  }

  async getComposerState(): Promise<{ available: boolean }> {
    return { available: this.composerAvailable }
  }

  async observeConversation(targetId: string): Promise<DriverObservation> {
    if (this.throwOnObserve) throw new ChatGptDriverError(this.throwOnObserve, 'mock observe error')
    return { messages: this.observable.get(targetId) ?? [], stopButtonPresent: this.stopButton }
  }

  async typeAndSubmit(_targetId: string, content: string): Promise<void> {
    this.typeAndSubmitCalls += 1
    this.reallySent.push(content)
    if (this.autoRevealSent) {
      for (let i = 0; i < this.revealCount; i += 1) this.appendUser(TARGET_ID, content)
    }
  }
}

function makeAdapter(driver: MockChatGptPageDriver): ChatGptBrowserAutomationAdapter {
  return new ChatGptBrowserAutomationAdapter({
    driver,
    idempotency: new InMemoryIdempotencyStore(),
  })
}

function singleTarget(): CdpTarget[] {
  return [{ id: TARGET_ID, url: 'https://chatgpt.com/c/conv-1', type: 'page', attached: true }]
}

const SUBMIT_INPUT = {
  conversation_ref: REF,
  content: 'do the thing',
  approval_ref: { kind: 'approval', ref: 'apr-1' },
}

describe('target resolution (fail-closed)', () => {
  test('target not found → NOT_FOUND', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = []
    const adapter = makeAdapter(driver)
    await expect(
      adapter.observeConversation({ conversation_ref: REF }, 1000),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  test('target ambiguous → UNAVAILABLE (never guess)', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = [
      { id: 'a', url: 'https://chatgpt.com/c/conv-1', type: 'page', attached: true },
      { id: 'b', url: 'https://chatgpt.com/c/conv-1', type: 'page', attached: true },
    ]
    const adapter = makeAdapter(driver)
    await expect(
      adapter.observeConversation({ conversation_ref: REF }, 1000),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  test('detached (attached:false) page target still resolves (normal foreground-tab state, not fail-closed)', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = [{ id: TARGET_ID, url: 'https://chatgpt.com/c/conv-1', type: 'page', attached: false }]
    const adapter = makeAdapter(driver)
    // CDP `attached:false` is the default for a normally-open foreground tab; true
    // usability is confirmed at connect time via the target's webSocketDebuggerUrl.
    await expect(
      adapter.observeConversation({ conversation_ref: REF }, 1000),
    ).resolves.toBeDefined()
  })
})

describe('health', () => {
  test('success when targets listable', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    const adapter = makeAdapter(driver)
    const health = await adapter.healthCheck(1000)
    expect(health.available).toBe(true)
    expect(health.capabilities).toContain('chatgpt-web')
  })

  test('list failure → UNAVAILABLE', async () => {
    const driver = new MockChatGptPageDriver()
    driver.throwOnList = 'transport'
    const adapter = makeAdapter(driver)
    await expect(adapter.healthCheck(1000)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})

describe('observe + streaming settled', () => {
  test('observes user and assistant messages with roles', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'hi', id: 'u-hi' },
      { role: 'assistant', text: 'hello', id: 'a-hello' },
    ])
    const adapter = makeAdapter(driver)
    const obs = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(obs.messages[0].settled).toBe(true)
  })

  test('new assistant appears', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [{ role: 'user', text: 'hi', id: 'u-hi' }])
    const adapter = makeAdapter(driver)
    const before = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    expect(before.messages).toHaveLength(1)

    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'hi', id: 'u-hi' },
      { role: 'assistant', text: 'fresh reply', id: 'a-fresh' },
    ])
    const after = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    expect(after.messages).toHaveLength(2)
    expect(after.messages[1].role).toBe('assistant')
  })

  test('streaming → settled: not settled while Stop present, settled after stable streak', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [{ role: 'assistant', text: 'partial', id: 'a-partial' }])
    driver.stopButton = true
    const adapter = makeAdapter(driver)

    const first = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    expect(first.messages[0].settled).toBe(false)

    driver.stopButton = false
    let lastSettled = false
    for (let i = 0; i < 5; i += 1) {
      const obs = await adapter.observeConversation({ conversation_ref: REF }, 1000)
      lastSettled = obs.messages[0].settled
    }
    expect(lastSettled).toBe(true)
  })

  test('since_fingerprint filters to messages after the marker', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'first', id: 'u-first' },
      { role: 'user', text: 'second', id: 'u-second' },
    ])
    const adapter = makeAdapter(driver)
    const before = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    const marker = before.messages[0].content_fingerprint
    const after = await adapter.observeConversation({ conversation_ref: REF, since_fingerprint: marker }, 1000)
    expect(after.messages).toHaveLength(1)
    expect(after.messages[0].content).toBe('second')
  })
})

describe('submit', () => {
  test('missing approval_ref → PERMISSION_REQUIRED', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    const adapter = makeAdapter(driver)
    await expect(
      adapter.submitUserMessage(
        { conversation_ref: REF, content: 'x', approval_ref: { kind: 'approval', ref: '' } },
        'op-1',
        1000,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' })
  })

  test('success: sends once and confirms via observation', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    const adapter = makeAdapter(driver)
    const receipt = await adapter.submitUserMessage(SUBMIT_INPUT, 'op-1', 1000)
    expect(receipt.content_fingerprint).toContain('|')
    expect(driver.typeAndSubmitCalls).toBe(1)
    const obs = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages.some(m => m.role === 'user' && m.content === 'do the thing')).toBe(true)
  })

  test('same idempotencyKey returns same receipt, no resend', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    const adapter = makeAdapter(driver)
    const r1 = await adapter.submitUserMessage(SUBMIT_INPUT, 'op-dup', 1000)
    const r2 = await adapter.submitUserMessage(SUBMIT_INPUT, 'op-dup', 1000)
    expect(r2.message_ref).toBe(r1.message_ref)
    expect(driver.typeAndSubmitCalls).toBe(1)
  })

  test('crash/recovery: effect happened, ack lost, recovery does NOT resend', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.autoRevealSent = false // simulate ack lost before observation
    const adapter = makeAdapter(driver)

    await expect(adapter.submitUserMessage(SUBMIT_INPUT, 'op-crash', 1000)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(driver.typeAndSubmitCalls).toBe(1) // side effect DID happen

    driver.revealSent() // recovery now sees the user message
    const recovered = await adapter.submitUserMessage(SUBMIT_INPUT, 'op-crash', 1000)
    expect(recovered.content_fingerprint).toContain('|')
    expect(driver.typeAndSubmitCalls).toBe(1) // no second send
  })

  test('different idempotencyKey + same content CAN be sent again', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    const adapter = makeAdapter(driver)
    await adapter.submitUserMessage(SUBMIT_INPUT, 'op-a', 1000)
    await adapter.submitUserMessage(SUBMIT_INPUT, 'op-b', 1000)
    expect(driver.typeAndSubmitCalls).toBe(2)
    const obs = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages.filter(m => m.role === 'user' && m.content === 'do the thing')).toHaveLength(2)
  })

  test('observe timeout during submit → TIMEOUT', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.throwOnObserve = 'timeout'
    const adapter = makeAdapter(driver)
    await expect(adapter.submitUserMessage(SUBMIT_INPUT, 'op-to', 1000)).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
  })

  test('target unavailable during submit → UNAVAILABLE', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = [] // resolution fails
    const adapter = makeAdapter(driver)
    await expect(adapter.submitUserMessage(SUBMIT_INPUT, 'op-na', 1000)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  test('composer unavailable → UNAVAILABLE (fail-closed, no send)', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.composerAvailable = false
    const adapter = makeAdapter(driver)
    await expect(adapter.submitUserMessage(SUBMIT_INPUT, 'op-co', 1000)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(driver.typeAndSubmitCalls).toBe(0)
  })
})

describe('M4-01-ID message identity contract', () => {
  test('same message observed repeatedly yields the same message_ref', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [{ role: 'user', text: 'stable', id: 'u-stable' }])
    const adapter = makeAdapter(driver)
    const a = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    const b = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    const c = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    expect(a.messages[0].message_ref).toBe(b.messages[0].message_ref)
    expect(b.messages[0].message_ref).toBe(c.messages[0].message_ref)
  })

  test('two different messages yield different message_refs', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'alpha', id: 'u-alpha' },
      { role: 'user', text: 'beta', id: 'u-beta' },
    ])
    const adapter = makeAdapter(driver)
    const obs = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages[0].message_ref).not.toBe(obs.messages[1].message_ref)
  })

  test('two messages with IDENTICAL content still yield different message_refs', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'same', id: 'u-same-1' },
      { role: 'user', text: 'same', id: 'u-same-2' },
    ])
    const adapter = makeAdapter(driver)
    const obs = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages[0].content).toBe(obs.messages[1].content)
    expect(obs.messages[0].message_ref).not.toBe(obs.messages[1].message_ref)
  })

  test('submit receipt message_ref matches the later-observed message_ref', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    const adapter = makeAdapter(driver)
    const receipt = await adapter.submitUserMessage(SUBMIT_INPUT, 'op-ref', 1000)
    expect(receipt.message_ref.startsWith('chatgpt:user:')).toBe(true)
    const obs = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    const landed = obs.messages.find(m => m.role === 'user' && m.content === SUBMIT_INPUT.content)
    expect(landed).toBeDefined()
    expect(landed!.message_ref).toBe(receipt.message_ref)
  })

  test('since_fingerprint does not alter a message_ref', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'a', id: 'u-a' },
      { role: 'user', text: 'b', id: 'u-b' },
      { role: 'user', text: 'c', id: 'u-c' },
    ])
    const adapter = makeAdapter(driver)
    const all = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    const refCAll = all.messages[2].message_ref
    const marker = all.messages[1].content_fingerprint
    const since = await adapter.observeConversation(
      { conversation_ref: REF, since_fingerprint: marker },
      1000,
    )
    expect(since.messages).toHaveLength(1)
    expect(since.messages[0].content).toBe('c')
    expect(since.messages[0].message_ref).toBe(refCAll)
  })

  test('reordering messages does not change their message_refs', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'x', id: 'u-x' },
      { role: 'user', text: 'y', id: 'u-y' },
    ])
    const adapter = makeAdapter(driver)
    const first = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    const refXFirst = first.messages[0].message_ref

    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'y', id: 'u-y' },
      { role: 'user', text: 'x', id: 'u-x' },
    ])
    const reordered = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    const refXReordered = reordered.messages.find(m => m.content === 'x')!.message_ref
    expect(refXReordered).toBe(refXFirst)
  })
})

describe('M4-01-ID-FIX defensive identity validation', () => {
  test('DEFECT-1: observe fails closed when a message has an empty stable id', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [{ role: 'user', text: 'hello', id: '' }])
    const adapter = makeAdapter(driver)
    // Must NOT return a ref like `chatgpt:user:`; must throw instead.
    await expect(
      adapter.observeConversation({ conversation_ref: REF }, 1000),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  test('DEFECT-3: observe fails closed on duplicate stable ids in one observation', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'A', id: 'same-id' },
      { role: 'user', text: 'B', id: 'same-id' },
    ])
    const adapter = makeAdapter(driver)
    // Must NOT emit two `chatgpt:user:same-id`; must throw.
    await expect(
      adapter.observeConversation({ conversation_ref: REF }, 1000),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  test('DEFECT-2 (0 candidates): submit fails closed when no new user message is observed', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.autoRevealSent = false // send happens but observation never reflects it
    const adapter = makeAdapter(driver)
    await expect(
      adapter.submitUserMessage(SUBMIT_INPUT, 'op-0', 1000),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(driver.typeAndSubmitCalls).toBe(1) // side effect DID happen, but unconfirmed
  })

  test('DEFECT-2 (1 candidate): receipt message_ref equals the new message observed ref', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'A', id: 'u-a' },
      { role: 'user', text: 'B', id: 'u-b' },
    ])
    const adapter = makeAdapter(driver)
    const receipt = await adapter.submitUserMessage(SUBMIT_INPUT, 'op-1c', 1000)
    // New message id from the mock is `m-1` (msgSeq starts at 0).
    expect(receipt.message_ref).toBe('chatgpt:user:m-1')
    const obs = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    const landed = obs.messages.find(m => m.message_ref === receipt.message_ref)
    expect(landed).toBeDefined()
    expect(landed!.content).toBe(SUBMIT_INPUT.content)
  })

  test('DEFECT-2 (>1 candidates): submit fails closed and returns neither C nor D', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'A', id: 'u-a' },
      { role: 'user', text: 'B', id: 'u-b' },
    ])
    driver.revealCount = 2 // a single send reveals TWO new user messages with same content
    const adapter = makeAdapter(driver)
    await expect(
      adapter.submitUserMessage(SUBMIT_INPUT, 'op-multi', 1000),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(driver.typeAndSubmitCalls).toBe(1) // exactly one external send, no guess/retry
  })

  test('DEFECT-3 (identical content, distinct ids): no identity collision', async () => {
    const driver = new MockChatGptPageDriver()
    driver.targets = singleTarget()
    driver.setMessages(TARGET_ID, [
      { role: 'user', text: 'same', id: 'u-same-1' },
      { role: 'user', text: 'same', id: 'u-same-2' },
    ])
    const adapter = makeAdapter(driver)
    const obs = await adapter.observeConversation({ conversation_ref: REF }, 1000)
    expect(obs.messages[0].message_ref).not.toBe(obs.messages[1].message_ref)
    expect(obs.messages[0].message_ref).toBe('chatgpt:user:u-same-1')
    expect(obs.messages[1].message_ref).toBe('chatgpt:user:u-same-2')
  })
})
