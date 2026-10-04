/**
 * M4-05 unit tests for the delivery approval binding primitives.
 *
 * Pure, offline, no clocks, no IO: the fingerprint is a deterministic function of
 * (content, conversation_ref), and the matcher additionally requires the
 * `external_browser_submit` kind and a matching hash.
 */

import { describe, expect, test } from 'bun:test'
import type { EvidenceRef } from '../contracts.js'
import type { ConversationRef } from '../ports/browserAutomationPort.js'
import {
  EXTERNAL_BROWSER_SUBMIT_APPROVAL_KIND,
  externalBrowserSubmitActionFingerprint,
  matchesExternalBrowserSubmitApproval,
} from './deliveryApproval.js'
import { hashPayload } from './idempotency.js'

const REF_A: ConversationRef = { adapter_id: 'adapter-a', conversation_id: 'conversation-c' }
const REF_B: ConversationRef = { adapter_id: 'adapter-a', conversation_id: 'conversation-other' }
const REF_C: ConversationRef = { adapter_id: 'adapter-other', conversation_id: 'conversation-c' }

function approvalFor(
  content: string,
  ref: ConversationRef = REF_A,
  overrides: Partial<EvidenceRef> = {},
): EvidenceRef {
  return {
    kind: EXTERNAL_BROWSER_SUBMIT_APPROVAL_KIND,
    ref: 'apr-1',
    hash: externalBrowserSubmitActionFingerprint({ conversation_ref: ref, content }),
    ...overrides,
  }
}

describe('M4-05 delivery approval fingerprint', () => {
  test('the approval kind is external_browser_submit', () => {
    expect(EXTERNAL_BROWSER_SUBMIT_APPROVAL_KIND).toBe('external_browser_submit')
  })

  test('fingerprint equals hashPayload({ action, conversation_ref, content })', () => {
    const expected = hashPayload({
      action: 'external_browser_submit',
      conversation_ref: { adapter_id: 'adapter-a', conversation_id: 'conversation-c' },
      content: 'X',
    })
    expect(
      externalBrowserSubmitActionFingerprint({ conversation_ref: REF_A, content: 'X' }),
    ).toBe(expected)
  })

  test('fingerprint is deterministic for the same input', () => {
    const first = externalBrowserSubmitActionFingerprint({ conversation_ref: REF_A, content: 'X' })
    const second = externalBrowserSubmitActionFingerprint({ conversation_ref: REF_A, content: 'X' })
    expect(first).toBe(second)
  })

  test('fingerprint changes when content changes', () => {
    const a = externalBrowserSubmitActionFingerprint({ conversation_ref: REF_A, content: 'X' })
    const b = externalBrowserSubmitActionFingerprint({ conversation_ref: REF_A, content: 'Y' })
    expect(a).not.toBe(b)
  })

  test('fingerprint changes when adapter_id changes', () => {
    const a = externalBrowserSubmitActionFingerprint({ conversation_ref: REF_A, content: 'X' })
    const c = externalBrowserSubmitActionFingerprint({ conversation_ref: REF_C, content: 'X' })
    expect(a).not.toBe(c)
  })

  test('fingerprint changes when conversation_id changes', () => {
    const a = externalBrowserSubmitActionFingerprint({ conversation_ref: REF_A, content: 'X' })
    const b = externalBrowserSubmitActionFingerprint({ conversation_ref: REF_B, content: 'X' })
    expect(a).not.toBe(b)
  })
})

describe('M4-05 delivery approval matcher', () => {
  test('accepts a correct external_browser_submit approval', () => {
    expect(
      matchesExternalBrowserSubmitApproval({
        approval_ref: approvalFor('X'),
        conversation_ref: REF_A,
        content: 'X',
      }),
    ).toBe(true)
  })

  test('rejects a wrong kind even with the correct hash', () => {
    expect(
      matchesExternalBrowserSubmitApproval({
        approval_ref: { kind: 'approval', ref: 'apr-1', hash: approvalFor('X').hash },
        conversation_ref: REF_A,
        content: 'X',
      }),
    ).toBe(false)
  })

  test('rejects an empty approval id', () => {
    expect(
      matchesExternalBrowserSubmitApproval({
        approval_ref: approvalFor('X', REF_A, { ref: '' }),
        conversation_ref: REF_A,
        content: 'X',
      }),
    ).toBe(false)
  })

  test('rejects a missing hash', () => {
    const approval: EvidenceRef = { kind: EXTERNAL_BROWSER_SUBMIT_APPROVAL_KIND, ref: 'apr-1' }
    expect(
      matchesExternalBrowserSubmitApproval({
        approval_ref: approval,
        conversation_ref: REF_A,
        content: 'X',
      }),
    ).toBe(false)
  })

  test('rejects an incorrect hash', () => {
    expect(
      matchesExternalBrowserSubmitApproval({
        approval_ref: approvalFor('X', REF_A, { hash: 'not-the-fingerprint' }),
        conversation_ref: REF_A,
        content: 'X',
      }),
    ).toBe(false)
  })

  test('rejects a hash computed for a different content', () => {
    expect(
      matchesExternalBrowserSubmitApproval({
        approval_ref: approvalFor('other'),
        conversation_ref: REF_A,
        content: 'X',
      }),
    ).toBe(false)
  })

  test('rejects a hash computed for a different conversation', () => {
    expect(
      matchesExternalBrowserSubmitApproval({
        approval_ref: approvalFor('X', REF_B),
        conversation_ref: REF_A,
        content: 'X',
      }),
    ).toBe(false)
  })
})
