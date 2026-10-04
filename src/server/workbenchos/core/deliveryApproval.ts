/**
 * M4-05 — delivery approval binding (narrow scope).
 *
 * This module is the SINGLE source of truth for the action fingerprint that binds
 * an `external_browser_submit` approval to the EXACT action: sending a specific
 * content to a specific conversation. No adapter may redefine this formula.
 *
 * Authorized by task package M4-05.
 */
import type { EvidenceRef } from '../contracts.js'
import type { ConversationRef } from '../ports/browserAutomationPort.js'
import { hashPayload } from './idempotency.js'

/** The approval type that protects result delivery back to the browser (C-16). */
export const EXTERNAL_BROWSER_SUBMIT_APPROVAL_KIND = 'external_browser_submit'

/**
 * Deterministic action fingerprint for an external browser submit.
 *
 * Formula (Core-owned, frozen by M4-05):
 *   hashPayload({ action: 'external_browser_submit', conversation_ref, content })
 * where `conversation_ref` carries exactly `adapter_id` and `conversation_id`.
 */
export function externalBrowserSubmitActionFingerprint(input: {
  conversation_ref: ConversationRef
  content: string
}): string {
  return hashPayload({
    action: EXTERNAL_BROWSER_SUBMIT_APPROVAL_KIND,
    conversation_ref: {
      adapter_id: input.conversation_ref.adapter_id,
      conversation_id: input.conversation_ref.conversation_id,
    },
    content: input.content,
  })
}

/**
 * True iff `approval_ref` is an `external_browser_submit` approval carrying a
 * non-empty approval id and a hash equal to the action fingerprint of this exact
 * (content, conversation) pair. Any other shape is NOT a valid approval.
 */
export function matchesExternalBrowserSubmitApproval(input: {
  approval_ref: EvidenceRef
  conversation_ref: ConversationRef
  content: string
}): boolean {
  const approval = input.approval_ref
  if (approval === null || typeof approval !== 'object') return false
  if (approval.kind !== EXTERNAL_BROWSER_SUBMIT_APPROVAL_KIND) return false
  if (typeof approval.ref !== 'string' || approval.ref.length === 0) return false
  if (typeof approval.hash !== 'string' || approval.hash.length === 0) return false
  return (
    approval.hash ===
    externalBrowserSubmitActionFingerprint({
      conversation_ref: input.conversation_ref,
      content: input.content,
    })
  )
}
