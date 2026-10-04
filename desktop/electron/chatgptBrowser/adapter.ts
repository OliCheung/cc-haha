/**
 * ChatGptBrowserAutomationAdapter — Electron-main implementation of the FROZEN
 * BrowserAutomationPort V0.1 (M4-01 / M4-02A).
 *
 * This is the B/C layer. All ChatGPT Web specifics (selectors, fingerprints,
 * streaming-settled heuristic, CDP target resolution) are confined here. Core
 * only ever sees the normalized contract types.
 *
 * Side-effect ordering follows the frozen contract:
 *   intent reserve → resolve target → send → observe-confirm → complete receipt.
 * The CDP send is performed by the injected driver; the adapter never wraps it in
 * a SQLite transaction of its own (the orchestrator commits intent before calling).
 */

import type {
  BrowserAutomationPortV01,
  BrowserAutomationHealth,
  ConversationObservation,
  ConversationRef,
  ObservedMessage,
  SubmitUserMessageInput,
  UserMessageReceipt,
} from '../../../src/server/workbenchos/ports/browserAutomationPort.js'
import { BrowserAutomationPortError } from '../../../src/server/workbenchos/ports/browserAutomationPort.js'
import type { CdpTarget, ChatGptPageDriver, DriverRawMessage } from './driver.js'
import { ChatGptDriverError } from './driver.js'
import { resolveConversationTarget } from './targetResolution.js'
import { fingerprintOf } from './fingerprint.js'
import {
  computeSettled,
  initialState,
  DEFAULT_SETTLE_STREAK_REQUIRED,
  type SettledState,
} from './settled.js'
import type { IdempotencyStore } from './idempotency.js'

export type ChatGptBrowserAutomationAdapterOptions = {
  driver: ChatGptPageDriver
  idempotency: IdempotencyStore
  settleStreakRequired?: number
  clock?: () => string
  capability?: string
}

export class ChatGptBrowserAutomationAdapter implements BrowserAutomationPortV01 {
  readonly protocolVersion = '0.1' as const

  private readonly driver: ChatGptPageDriver
  private readonly idempotency: IdempotencyStore
  private readonly streakRequired: number
  private readonly clock: () => string
  private readonly capability: string
  // Per-target streaming-settled state. Adapter-only; never leaks to Core.
  private readonly settleState = new Map<string, SettledState>()

  constructor(options: ChatGptBrowserAutomationAdapterOptions) {
    this.driver = options.driver
    this.idempotency = options.idempotency
    this.streakRequired = options.settleStreakRequired ?? DEFAULT_SETTLE_STREAK_REQUIRED
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.capability = options.capability ?? 'chatgpt-web'
  }

  async healthCheck(_timeoutMs: number): Promise<BrowserAutomationHealth> {
    try {
      await this.driver.listTargets()
    } catch {
      throw new BrowserAutomationPortError({
        code: 'UNAVAILABLE',
        message: 'browser automation health check failed',
        retryable: false,
      })
    }
    return {
      protocol_version: '0.1',
      available: true,
      capabilities: [this.capability, 'observe', 'submit'],
    }
  }

  async observeConversation(
    input: { conversation_ref: ConversationRef; since_fingerprint?: string },
    _timeoutMs: number,
  ): Promise<ConversationObservation> {
    const targetId = await this.requireTarget(input.conversation_ref)
    const observation = await this.guard(() => this.driver.observeConversation(targetId))
    this.assertStableIdentities(observation.messages)

    const messages: ObservedMessage[] = observation.messages.map((m) => {
      const fp = fingerprintOf(m.text)
      return {
        role: m.role,
        message_ref: `chatgpt:${m.role}:${m.id}`,
        content: m.text,
        content_fingerprint: fp,
        settled: m.role === 'user',
      }
    })

    const lastAssistantIndex = lastIndexOfRole(messages, 'assistant')
    if (lastAssistantIndex >= 0) {
      const target = messages[lastAssistantIndex]
      if (target) {
        const prev = this.settleState.get(targetId) ?? initialState()
        const { settled, next } = computeSettled(
          prev,
          target.content_fingerprint,
          observation.stopButtonPresent,
          this.streakRequired,
        )
        this.settleState.set(targetId, next)
        messages[lastAssistantIndex] = { ...target, settled }
      }
    }

    let visible = messages
    if (input.since_fingerprint) {
      const idx = messages.findIndex(m => m.content_fingerprint === input.since_fingerprint)
      visible = idx >= 0 ? messages.slice(idx + 1) : messages
    }

    return {
      observed_at: this.clock(),
      conversation_fingerprint: `cfp:${fingerprintOf(
        visible.map(m => `${m.role}:${m.content_fingerprint}`).join('|'),
      )}`,
      messages: visible,
    }
  }

  async submitUserMessage(
    input: SubmitUserMessageInput,
    idempotencyKey: string,
    _timeoutMs: number,
  ): Promise<UserMessageReceipt> {
    if (!input.approval_ref || input.approval_ref.ref.length === 0) {
      throw new BrowserAutomationPortError({
        code: 'PERMISSION_REQUIRED',
        message: 'submitUserMessage requires a valid approval_ref',
        retryable: false,
      })
    }

    // intent persisted (reserve). If already completed → same receipt, no resend.
    const prior = await this.idempotency.get(idempotencyKey)
    const reserved = await this.idempotency.reserve(idempotencyKey)
    if (reserved.receipt !== null) return reserved.receipt

    const fingerprint = fingerprintOf(input.content)
    const targetId = await this.requireTarget(input.conversation_ref)

    // Adapter-level recovery (in-memory store only; cross-restart recovery is the
    // Core/Journal's responsibility). Triggered only when this exact key had a prior
    // reserved-but-uncompleted attempt. We identify the SPECIFIC observed message
    // (by stable id) rather than merely "any matching fingerprint", so the receipt
    // carries that message's stable identity (M4-01-ID consistency).
    if (prior !== null && prior.receipt === null) {
      const existing = await this.guard(() => this.driver.observeConversation(targetId))
      const priorMsg = existing.messages.find(
        m => m.role === 'user' && m.id.length > 0 && fingerprintOf(m.text) === fingerprint,
      )
      if (priorMsg) {
        const receipt = this.buildReceipt(priorMsg)
        await this.idempotency.complete(idempotencyKey, receipt)
        return receipt
      }
      // Effect not observable → fall through and resend (the send may have been lost).
    }

    // new operation: perform exactly one external send (side effect, outside any txn)
    const composer = await this.guard(() => this.driver.getComposerState(targetId))
    if (!composer.available) {
      throw new BrowserAutomationPortError({
        code: 'UNAVAILABLE',
        message: 'composer unavailable',
        retryable: false,
      })
    }

    // Capture the set of user message ids BEFORE the send so the new message can be
    // identified by stable id afterwards — never by array position (M4-01-ID).
    const before = await this.guard(() => this.driver.observeConversation(targetId))
    const beforeUserIds = new Set(
      before.messages.filter(m => m.role === 'user').map(m => m.id),
    )

    await this.guard(() => this.driver.typeAndSubmit(targetId, input.content))

    // confirm the user message actually appeared (fail-closed: unproven ⇒ UNAVAILABLE).
    // Identify it by stable id, not position.
    const after = await this.guard(() => this.driver.observeConversation(targetId))
    // Identify the new message by stable id, never by position. Exactly one candidate
    // is acceptable; zero (send unconfirmed) or more than one (ambiguous) both fail
    // closed — never guess via first/last/nearest (M4-01-ID-FIX).
    const candidates = after.messages.filter(
      m =>
        m.role === 'user' &&
        m.id.length > 0 &&
        fingerprintOf(m.text) === fingerprint &&
        !beforeUserIds.has(m.id),
    )
    if (candidates.length !== 1) {
      throw new BrowserAutomationPortError({
        code: 'UNAVAILABLE',
        message: `submitted user message not uniquely observed (${candidates.length} candidates); send unconfirmed`,
        retryable: false,
      })
    }

    const receipt = this.buildReceipt(candidates[0])
    await this.idempotency.complete(idempotencyKey, receipt)
    return receipt
  }

  // ---- internals ----

  /**
   * Fail-closed identity validation (M4-01-ID-FIX). Every message that enters the
   * port contract must carry a non-empty, unique-within-observation stable id. An
   * empty id or a duplicate id means we cannot produce a durable, unique
   * `message_ref`, so we must NOT synthesize one (no index / fingerprint / position
   * fallback) — we surface a contract failure instead.
   */
  private assertStableIdentities(messages: DriverRawMessage[]): void {
    const seen = new Set<string>()
    for (const m of messages) {
      if (m.id.length === 0) {
        throw new BrowserAutomationPortError({
          code: 'UNAVAILABLE',
          message: 'observed message without a stable id; identity contract unmet',
          retryable: false,
        })
      }
      if (seen.has(m.id)) {
        throw new BrowserAutomationPortError({
          code: 'UNAVAILABLE',
          message: `duplicate stable id ${m.id} in one observation; identity contract unmet`,
          retryable: false,
        })
      }
      seen.add(m.id)
    }
  }

  private buildReceipt(message: DriverRawMessage): UserMessageReceipt {
    return {
      message_ref: `chatgpt:${message.role}:${message.id}`,
      accepted_at: this.clock(),
      content_fingerprint: fingerprintOf(message.text),
    }
  }

  private async requireTarget(ref: ConversationRef): Promise<string> {
    let targets: CdpTarget[]
    try {
      targets = await this.driver.listTargets()
    } catch {
      throw new BrowserAutomationPortError({
        code: 'UNAVAILABLE',
        message: 'failed to list browser targets',
        retryable: false,
      })
    }
    const resolved = resolveConversationTarget(targets, ref)
    if (!resolved.ok) {
      const code = resolved.reason === 'not_found' ? 'NOT_FOUND' : 'UNAVAILABLE'
      throw new BrowserAutomationPortError({
        code,
        message: `target resolution failed: ${resolved.reason}`,
        retryable: false,
      })
    }
    return resolved.targetId
  }

  /** Maps driver failures to generic Port error codes (no ChatGPT specifics leak). */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      throw mapDriverError(err)
    }
  }
}

function lastIndexOfRole(messages: ObservedMessage[], role: 'user' | 'assistant'): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === role) return i
  }
  return -1
}

function mapDriverError(err: unknown): BrowserAutomationPortError {
  if (err instanceof BrowserAutomationPortError) return err
  if (err instanceof ChatGptDriverError) {
    const code = err.reason === 'target_not_found' ? 'NOT_FOUND' : err.reason === 'timeout' ? 'TIMEOUT' : 'UNAVAILABLE'
    return new BrowserAutomationPortError({ code, message: err.message, retryable: false })
  }
  return new BrowserAutomationPortError({
    code: 'INTERNAL',
    message: err instanceof Error ? err.message : 'unknown browser driver error',
    retryable: false,
  })
}
