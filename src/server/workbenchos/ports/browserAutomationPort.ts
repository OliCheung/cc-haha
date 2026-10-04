/**
 * WorkbenchOS BrowserAutomationPort V0.1 — FROZEN contract.
 *
 * Boundary rule (C-04 / C-06): the core sees only normalized conversation
 * observations, opaque message refs, content fingerprints, a `settled` flag and
 * generic errors. No vendor wire data, no DOM, no debugging-protocol handles,
 * no element-query strings, no `native_target_ref`, no `STALE_TARGET`.
 *
 * Message identity contract (M4-01-ID): `message_ref` is an OPAQUE, STABLE,
 * UNIQUE-WITHIN-CONVERSATION identifier for a logical message.
 *   - Stable: the same logical message yields the SAME `message_ref` across
 *     multiple `observeConversation` calls, independent of array position,
 *     observation window, pagination, or `since_fingerprint`.
 *   - Unique: two distinct logical messages in the same conversation yield
 *     DISTINCT `message_ref`, even when their content is identical.
 *   - Consistent: `submitUserMessage`'s `UserMessageReceipt.message_ref` equals
 *     the `ObservedMessage.message_ref` of that same message on a later observe.
 *   - `since_fingerprint` is ONLY a hint that limits the returned range; it MUST
 *     NOT alter any `message_ref`.
 * Core must not parse the internal format of `message_ref`.
 *
 * This is the single source of truth for the contract; see
 * docs/tasks/M4-01_BROWSER_AUTOMATION_PORT_CONTRACT.md (Status: FROZEN, v0.1).
 *
 * Authorized by task package M4-02A.
 */

import type { EvidenceRef } from '../contracts.js'

export type ConversationRef = {
  adapter_id: string
  conversation_id: string
}

export type BrowserAutomationHealth = {
  protocol_version: '0.1'
  available: boolean
  capabilities: string[]
  detail?: string
}

export type ObservedMessage = {
  role: 'user' | 'assistant'
  /** Stable, unique-within-conversation message identity (M4-01-ID). Opaque to Core. */
  message_ref: string
  content: string
  content_fingerprint: string
  settled: boolean
}

export type ConversationObservation = {
  observed_at: string
  conversation_fingerprint: string
  messages: ObservedMessage[]
}

export type SubmitUserMessageInput = {
  conversation_ref: ConversationRef
  content: string
  approval_ref: EvidenceRef
}

export type UserMessageReceipt = {
  /** Stable, unique-within-conversation message identity (M4-01-ID). Matches the observed message's `message_ref`. */
  message_ref: string
  accepted_at: string
  content_fingerprint: string
}

/**
 * Generic error codes exposed to Core. No vendor-specific codes; no
 * `STALE_TARGET` (target staleness is absorbed by the adapter and surfaced as
 * `UNAVAILABLE` / `NOT_FOUND`).
 */
export type BrowserAutomationPortErrorCode =
  | 'VERSION_MISMATCH'
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'PERMISSION_REQUIRED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INTERNAL'

/**
 * The only error type a BrowserAutomationPort implementation may throw.
 * `evidenceRef`, if present, is adapter-side and must never carry element-query
 * strings / DOM / debugging-protocol / token data.
 */
export class BrowserAutomationPortError extends Error {
  readonly code: BrowserAutomationPortErrorCode
  readonly retryable: boolean
  readonly evidenceRef?: EvidenceRef

  constructor(input: {
    code: BrowserAutomationPortErrorCode
    message: string
    retryable: boolean
    evidenceRef?: EvidenceRef
  }) {
    super(input.message)
    this.name = 'BrowserAutomationPortError'
    this.code = input.code
    this.retryable = input.retryable
    this.evidenceRef = input.evidenceRef
  }
}

export interface BrowserAutomationPortV01 {
  readonly protocolVersion: '0.1'

  healthCheck(timeoutMs: number): Promise<BrowserAutomationHealth>

  observeConversation(
    input: { conversation_ref: ConversationRef; since_fingerprint?: string },
    timeoutMs: number,
  ): Promise<ConversationObservation>

  submitUserMessage(
    input: SubmitUserMessageInput,
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<UserMessageReceipt>
}
