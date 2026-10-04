/**
 * FakeBrowserAutomationPort — a fully deterministic, scriptable
 * BrowserAutomationPortV01 implementation.
 *
 * Determinism rules (consistent with FakeAgentPort, M1-001-P5 §7 F5):
 *   - no timer APIs; streaming state only advances via `markAssistantSettled`
 *   - no real clock and no randomness; every timestamp comes from `options.clock`
 *   - `observeConversation` is read-only: it never changes streaming state
 *   - `getCalls()` hands out copies; `getSendCount()` lets tests assert side effects
 *
 * This fake mirrors the FROZEN v0.1 contract only. It deliberately exposes no
 * vendor-specific, debugging-protocol, or DOM-query concepts: the adapter layer
 * is where those live.
 *
 * Authorized by task package M4-02A.
 */

import {
  BrowserAutomationPortError,
  type BrowserAutomationHealth,
  type BrowserAutomationPortV01,
  type ConversationObservation,
  type ConversationRef,
  type ObservedMessage,
  type SubmitUserMessageInput,
  type UserMessageReceipt,
} from '../ports/browserAutomationPort.js'

export type FakeBrowserSubmitMode =
  | 'accept'
  | 'timeout'
  | 'unavailable'
  | 'permission'
  | 'not_found'
  | 'idempotency_conflict'
  | 'effect_then_lost_ack'

export type FakeBrowserFault =
  | 'health_unavailable'
  | 'observe_unavailable'
  | 'observe_not_found'
  | 'observe_timeout'

export type FakeBrowserCall = {
  method: 'healthCheck' | 'observeConversation' | 'submitUserMessage'
  conversation_ref?: ConversationRef
  idempotency_key?: string
}

export type FakeBrowserAutomationPortOptions = {
  /** Capability name reported by healthCheck. Defaults to 'fake-browser'. */
  capability?: string
  /** Timestamp source. Defaults to a constant, so the port is fully deterministic. */
  clock?: () => string
}

type InternalMessage = {
  role: 'user' | 'assistant'
  message_ref: string
  content: string
  content_fingerprint: string
  settled: boolean
  produced_by_key?: string
}

const DEFAULT_CLOCK = (): string => '2026-01-01T00:00:00.000Z'

function hashString(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function fingerprintFor(content: string): string {
  return `fp:${hashString(content)}`
}

function conversationKey(ref: ConversationRef): string {
  return `${ref.adapter_id}::${ref.conversation_id}`
}

export class FakeBrowserAutomationPort implements BrowserAutomationPortV01 {
  readonly protocolVersion = '0.1' as const

  private readonly capability: string
  private readonly clock: () => string
  private readonly faults = new Set<FakeBrowserFault>()
  private nextSubmitMode: FakeBrowserSubmitMode = 'accept'
  private readonly conversations = new Map<string, InternalMessage[]>()
  private readonly idempotencyBindings = new Map<
    string,
    { message_ref: string; receipt: UserMessageReceipt | null }
  >()
  private sendCount = 0
  private msgCounter = 0
  private readonly calls: FakeBrowserCall[] = []

  constructor(options: FakeBrowserAutomationPortOptions = {}) {
    this.capability = options.capability ?? 'fake-browser'
    this.clock = options.clock ?? DEFAULT_CLOCK
  }

  // ---------------------------------------------------------------------------
  // Scripted control surface
  // ---------------------------------------------------------------------------

  /** Sets the behavior of the NEXT submitUserMessage attempt, then resets to 'accept'. */
  setNextSubmitMode(mode: FakeBrowserSubmitMode): void {
    this.nextSubmitMode = mode
  }

  injectFault(fault: FakeBrowserFault): void {
    this.faults.add(fault)
  }

  clearFaults(): void {
    this.faults.clear()
  }

  /** Script a pre-existing user message (not via submit; no idempotency side effect). */
  addUserMessage(ref: ConversationRef, content: string, settled = true): string {
    const message_ref = `msg-${++this.msgCounter}`
    this.getMessages(ref).push({
      role: 'user',
      message_ref,
      content,
      content_fingerprint: fingerprintFor(content),
      settled,
    })
    return message_ref
  }

  /** Script an assistant message. Pass settled=false to model an in-flight stream. */
  addAssistantMessage(ref: ConversationRef, content: string, settled = false): string {
    const message_ref = `msg-${++this.msgCounter}`
    this.getMessages(ref).push({
      role: 'assistant',
      message_ref,
      content,
      content_fingerprint: fingerprintFor(content),
      settled,
    })
    return message_ref
  }

  /** Deterministically advance an in-flight assistant stream to settled. */
  markAssistantSettled(message_ref: string): void {
    for (const messages of this.conversations.values()) {
      const found = messages.find(m => m.message_ref === message_ref)
      if (found !== undefined) {
        found.settled = true
        return
      }
    }
  }

  getCalls(): FakeBrowserCall[] {
    return this.calls.map(call => ({ ...call }))
  }

  getSendCount(): number {
    return this.sendCount
  }

  resetCalls(): void {
    this.calls.length = 0
  }

  listMessages(ref: ConversationRef): ObservedMessage[] {
    return this.getMessages(ref).map(toObserved)
  }

  // ---------------------------------------------------------------------------
  // BrowserAutomationPortV01
  // ---------------------------------------------------------------------------

  async healthCheck(_timeoutMs: number): Promise<BrowserAutomationHealth> {
    this.calls.push({ method: 'healthCheck' })
    if (this.faults.has('health_unavailable')) {
      throw new BrowserAutomationPortError({
        code: 'UNAVAILABLE',
        message: 'fake browser automation health unavailable',
        retryable: false,
      })
    }
    return {
      protocol_version: '0.1',
      available: true,
      capabilities: [this.capability],
    }
  }

  async observeConversation(
    input: { conversation_ref: ConversationRef; since_fingerprint?: string },
    _timeoutMs: number,
  ): Promise<ConversationObservation> {
    this.calls.push({
      method: 'observeConversation',
      conversation_ref: input.conversation_ref,
    })

    if (this.faults.has('observe_unavailable')) {
      throw new BrowserAutomationPortError({
        code: 'UNAVAILABLE',
        message: 'fake conversation observation unavailable',
        retryable: false,
      })
    }
    if (this.faults.has('observe_not_found')) {
      throw new BrowserAutomationPortError({
        code: 'NOT_FOUND',
        message: 'fake conversation not found',
        retryable: false,
      })
    }
    if (this.faults.has('observe_timeout')) {
      throw new BrowserAutomationPortError({
        code: 'TIMEOUT',
        message: 'fake conversation observation timed out',
        retryable: false,
      })
    }

    const all = this.getMessages(input.conversation_ref)
    let visible = all
    if (input.since_fingerprint !== undefined) {
      const idx = all.findIndex(m => m.content_fingerprint === input.since_fingerprint)
      visible = idx >= 0 ? all.slice(idx + 1) : all
    }

    return {
      observed_at: this.clock(),
      conversation_fingerprint: `cfp:${hashString(
        JSON.stringify(visible.map(m => ({ r: m.role, c: m.content, s: m.settled }))),
      )}`,
      messages: visible.map(toObserved),
    }
  }

  async submitUserMessage(
    input: SubmitUserMessageInput,
    idempotencyKey: string,
    _timeoutMs: number,
  ): Promise<UserMessageReceipt> {
    this.calls.push({
      method: 'submitUserMessage',
      conversation_ref: input.conversation_ref,
      idempotency_key: idempotencyKey,
    })

    // The scripted mode applies to THIS attempt only (consumed immediately).
    const mode = this.nextSubmitMode
    this.nextSubmitMode = 'accept'

    // Pure failures: no submission is performed, no idempotency record touched.
    switch (mode) {
      case 'timeout':
        throw new BrowserAutomationPortError({
          code: 'TIMEOUT',
          message: `fake submit ${idempotencyKey} timed out`,
          retryable: true,
        })
      case 'unavailable':
        throw new BrowserAutomationPortError({
          code: 'UNAVAILABLE',
          message: `fake browser unavailable for submit ${idempotencyKey}`,
          retryable: false,
        })
      case 'permission':
        throw new BrowserAutomationPortError({
          code: 'PERMISSION_REQUIRED',
          message: 'fake submit missing or invalid approval_ref',
          retryable: false,
        })
      case 'not_found':
        throw new BrowserAutomationPortError({
          code: 'NOT_FOUND',
          message: `fake conversation not found for submit ${idempotencyKey}`,
          retryable: false,
        })
      case 'idempotency_conflict':
        throw new BrowserAutomationPortError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: `fake idempotency conflict for key ${idempotencyKey}`,
          retryable: false,
        })
      default:
        break
    }

    const existingBinding = this.idempotencyBindings.get(idempotencyKey)
    if (existingBinding !== undefined) {
      // Already completed under this exact key → return the same receipt, no resend.
      if (existingBinding.receipt !== null) {
        return existingBinding.receipt
      }
      // Crash/recovery: send effect happened, ack lost before receipt persisted.
      // content_fingerprint recovery lookup — the user message is already present.
      const existing = this.getMessages(input.conversation_ref).find(
        m => m.message_ref === existingBinding.message_ref && m.role === 'user',
      )
      if (existing !== undefined) {
        const receipt = this.buildReceipt(existing)
        existingBinding.receipt = receipt
        return receipt
      }
      // Defensive: not found, fall through to a fresh send.
    }

    // New operation: perform exactly one external send (append the user message).
    const fingerprint = fingerprintFor(input.content)
    const message_ref = `msg-${++this.msgCounter}`
    const message: InternalMessage = {
      role: 'user',
      message_ref,
      content: input.content,
      content_fingerprint: fingerprint,
      settled: true,
      produced_by_key: idempotencyKey,
    }
    this.getMessages(input.conversation_ref).push(message)
    this.sendCount += 1

    const binding = { message_ref, receipt: null }
    this.idempotencyBindings.set(idempotencyKey, binding)

    // Crash injection: effect applied, but the acknowledgement is lost before the
    // receipt is persisted. A retry with the same key recovers without resending.
    if (mode === 'effect_then_lost_ack') {
      throw new BrowserAutomationPortError({
        code: 'TIMEOUT',
        message: `fake acknowledgement for ${message_ref} lost after the effect`,
        retryable: true,
      })
    }

    const receipt = this.buildReceipt(message)
    binding.receipt = receipt
    return receipt
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private getMessages(ref: ConversationRef): InternalMessage[] {
    const key = conversationKey(ref)
    let messages = this.conversations.get(key)
    if (messages === undefined) {
      messages = []
      this.conversations.set(key, messages)
    }
    return messages
  }

  private buildReceipt(message: InternalMessage): UserMessageReceipt {
    return {
      message_ref: message.message_ref,
      accepted_at: this.clock(),
      content_fingerprint: message.content_fingerprint,
    }
  }
}

function toObserved(message: InternalMessage): ObservedMessage {
  return {
    role: message.role,
    message_ref: message.message_ref,
    content: message.content,
    content_fingerprint: message.content_fingerprint,
    settled: message.settled,
  }
}
