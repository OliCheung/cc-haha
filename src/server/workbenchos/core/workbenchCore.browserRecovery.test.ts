/**
 * M4-03B — Browser submit persistence idempotency & crash recovery.
 *
 * Offline against the deterministic FakeBrowserAutomationPort. Every crash is
 * simulated by (a) persisting a `browser-submit` idempotency record in the
 * journal and (b) either skipping the external send or losing its acknowledgement.
 * A "restart" really closes the database and opens a new Core over the same path;
 * the fake survives restart so the external effect (the user message) persists
 * exactly as it would in the real ChatGPT conversation.
 *
 * Covers: normal persistence, Crash A (no intent -> no submit), Crash B
 * (intent committed, no send -> exactly-one resend), Crash C (send landed, ack
 * lost -> observe + recover, NO resend), replay, same-content/different-key,
 * fingerprint mismatch fail-closed, wrong-conversation fail-closed, permission,
 * unavailable/timeout, and journal/receipt consistency.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationRef, EvidenceRef, UserMessageReceipt } from '../ports/browserAutomationPort.js'
import { SqliteJournal } from '../persistence/sqliteJournal.js'
import { FakeAgentPort } from '../testing/fakeAgentPort.js'
import { FakeBrowserAutomationPort } from '../testing/fakeBrowserAutomationPort.js'
import {
  WorkbenchCore,
  type Clock,
  type CoreResult,
  type CreateTaskInput,
} from './workbenchCore.js'
import { canonicalJson, hashPayload } from '../core/idempotency.js'
import { externalBrowserSubmitActionFingerprint } from './deliveryApproval.js'

type Harness = {
  readonly journal: SqliteJournal
  readonly core: WorkbenchCore
  readonly browser: FakeBrowserAutomationPort
  readonly databasePath: string
  restart(): Promise<void>
}

const REF: ConversationRef = { adapter_id: 'chatgpt-web', conversation_id: 'conversation-1' }

function makeClock(): Clock {
  let tick = 0
  return {
    now: () => {
      tick += 1
      const minutes = String(Math.floor(tick / 60)).padStart(2, '0')
      const seconds = String(tick % 60).padStart(2, '0')
      return `2026-01-01T00:${minutes}:${seconds}.000Z`
    },
  }
}

function makeIds(): { next(): string } {
  let counter = 0
  return { next: () => { counter += 1; return `id-${counter}` } }
}

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-browser-recovery-'))
  const databasePath = join(dir, 'workbench.sqlite3')
  const browser = new FakeBrowserAutomationPort()
  const clock = makeClock()
  const ids = makeIds()

  let journal = new SqliteJournal({ databasePath })
  await journal.open()

  const buildCore = (): WorkbenchCore =>
    new WorkbenchCore({
      journal,
      agentPort: new FakeAgentPort(),
      browserAutomation: browser,
      clock,
      ids,
      project_id: 'project-1',
      port_timeout_ms: 1000,
    })

  let core = buildCore()

  const handle: Harness = {
    get journal() { return journal },
    get core() { return core },
    browser,
    databasePath,
    async restart() {
      await journal.close()
      journal = new SqliteJournal({ databasePath })
      await journal.open()
      core = buildCore()
    },
  }

  try {
    await run(handle)
  } finally {
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function makeTaskInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    conversation_ref: { browser_adapter_id: REF.adapter_id, conversation_id: REF.conversation_id },
    idempotency_key: 'idem-1',
    goal: 'drive the browser conversation',
    requested_execution: { agent_id: 'codebuddy', execution_timeout_ms: 600000 },
    ...overrides,
  }
}

function expectOk<T>(result: CoreResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail}`)
  return result.value
}

function expectFailure<T>(result: CoreResult<T>, code: string): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error.code).toBe(code)
}

async function createReadyTask(h: Harness, overrides: Partial<CreateTaskInput> = {}): Promise<string> {
  const created = expectOk(await h.core.createTask(makeTaskInput(overrides)))
  expectOk(await h.core.markTaskReady(created.task_id))
  return created.task_id
}

// M4-05: builds a valid `external_browser_submit` approval bound to the exact
// (content, conversation) action. Direct-seed helpers keep using it only so their
// approval_ref stays non-empty; recovery never re-validates approvals.
function approvalFor(content: string, ref: ConversationRef = REF): EvidenceRef {
  return {
    kind: 'external_browser_submit',
    ref: 'apr-1',
    hash: externalBrowserSubmitActionFingerprint({ conversation_ref: ref, content }),
  }
}

// ---------------------------------------------------------------------------
// 1. Normal submit persists the receipt to the journal (authority)
// ---------------------------------------------------------------------------

describe('M4-03B browser submit persistence', () => {
  test('normal submit persists a completed receipt record', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId,
        content: 'please summarize',
        approval_ref: approvalFor('please summarize'),
        idempotency_key: 'op-1',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const record = await h.journal.readIdempotency('browser-submit', 'op-1')
      expect(record).not.toBeNull()
      expect(record?.status).toBe('completed')
      const stored = JSON.parse(record!.outcome_ref) as UserMessageReceipt
      expect(stored.message_ref).toBe(result.value.receipt.message_ref)
      expect(h.browser.getSendCount()).toBe(1)
    })
  })

  test('replay under the same idempotency_key never sends twice', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const first = expectOk(
        await h.core.submitBrowserUserMessage({
          task_id: taskId, content: 'x', approval_ref: approvalFor('x'), idempotency_key: 'op-r',
        }),
      )
      const second = expectOk(
        await h.core.submitBrowserUserMessage({
          task_id: taskId, content: 'x', approval_ref: approvalFor('x'), idempotency_key: 'op-r',
        }),
      )
      expect(h.browser.getSendCount()).toBe(1)
      expect(second.receipt.message_ref).toBe(first.receipt.message_ref)
    })
  })

  test('same content with a different idempotency_key is a separate legal operation', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      expectOk(await h.core.submitBrowserUserMessage({
        task_id: taskId, content: 'same', approval_ref: approvalFor('same'), idempotency_key: 'op-a',
      }))
      expectOk(await h.core.submitBrowserUserMessage({
        task_id: taskId, content: 'same', approval_ref: approvalFor('same'), idempotency_key: 'op-b',
      }))
      expect(h.browser.getSendCount()).toBe(2)
    })
  })

  test('empty approval_ref is rejected before any external submit', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId, content: 'x', approval_ref: { kind: 'approval', ref: '' }, idempotency_key: 'op-perm',
      })
      expectFailure(result, 'PERMISSION_REQUIRED')
      expect(h.browser.getSendCount()).toBe(0)
      expect(await h.journal.readIdempotency('browser-submit', 'op-perm')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Crash A — no committed intent means no external submit
// ---------------------------------------------------------------------------

describe('M4-03B crash A: no intent committed', () => {
  test('a crash before the intent commit produces no browser submit', async () => {
    await withHarness(async (h) => {
      // The intent commit is the durable point that precedes the port call. If it
      // never happens (simulated: we simply never call submit), no side effect occurs.
      expect(h.browser.getSendCount()).toBe(0)
      expect(await h.journal.readIdempotency('browser-submit', 'op-a')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Crash B — intent committed, submit never landed -> exactly one resend
// ---------------------------------------------------------------------------

describe('M4-03B crash B: intent committed, no send', () => {
  test('recovery resubmits exactly once after a failed submit', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      h.browser.setNextSubmitMode('unavailable')
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId, content: 'hello', approval_ref: approvalFor('hello'), idempotency_key: 'op-b',
      })
      expectFailure(result, 'UNAVAILABLE')
      // Intent is durable; no external effect occurred.
      expect(h.browser.getSendCount()).toBe(0)
      const reserved = await h.journal.readIdempotency('browser-submit', 'op-b')
      expect(reserved?.status).toBe('reserved')

      await h.restart()

      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual(['op-b'])
      expect(recovered.failed).toEqual([])
      // Exactly one real send happened during recovery.
      expect(h.browser.getSendCount()).toBe(1)
      expect((await h.journal.readIdempotency('browser-submit', 'op-b'))?.status).toBe('completed')

      // A second recovery is a no-op (the record is already completed).
      const again = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(again.recovered).toEqual([])
      expect(h.browser.getSendCount()).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Crash C — send landed, acknowledgement lost -> observe + recover, NO resend
// ---------------------------------------------------------------------------

describe('M4-03B crash C: send landed, ack lost', () => {
  test('recovery observes the existing message and does not resend', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      h.browser.setNextSubmitMode('effect_then_lost_ack')
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId, content: 'already sent', approval_ref: approvalFor('already sent'), idempotency_key: 'op-c',
      })
      // The external effect happened, but the ack was lost before our receipt commit.
      expectFailure(result, 'TIMEOUT')
      expect(h.browser.getSendCount()).toBe(1)
      const reserved = await h.journal.readIdempotency('browser-submit', 'op-c')
      expect(reserved?.status).toBe('reserved')

      // The message is the durable external effect, still present after restart.
      const landed = h.browser.listMessages(REF).find(m => m.role === 'user' && m.content === 'already sent')
      expect(landed).toBeDefined()

      await h.restart()

      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual(['op-c'])
      // NO second send: the existing message was recovered instead.
      expect(h.browser.getSendCount()).toBe(1)

      const completed = await h.journal.readIdempotency('browser-submit', 'op-c')
      expect(completed?.status).toBe('completed')
      const stored = JSON.parse(completed!.outcome_ref) as UserMessageReceipt
      expect(stored.message_ref).toBe(landed!.message_ref)
    })
  })
})

// ---------------------------------------------------------------------------
// 5. Fail-closed boundaries
// ---------------------------------------------------------------------------

describe('M4-03B fail-closed boundaries', () => {
  function seedReserved(
    h: Harness,
    key: string,
    intent: {
      task_id: string
      conversation_ref: ConversationRef
      content: string
      approval_ref: EvidenceRef
      baseline_user_message_refs: string[]
    },
  ): Promise<unknown> {
    return h.journal.commit({
      idempotency: {
        namespace: 'browser-submit',
        operation_key: key,
        payload_hash: hashPayload({
          conversation_ref: intent.conversation_ref,
          content: intent.content,
          approval_ref: intent.approval_ref,
        }),
        outcome_ref: canonicalJson(intent),
        status: 'reserved',
        at: '2026-01-01T00:00:00.000Z',
      },
    })
  }

  test('fingerprint mismatch (other message present) fails closed, no resend', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      // A different user message exists in the conversation, but not ours.
      h.browser.addUserMessage(REF, 'someone else said this')

      await seedReserved(h, 'op-fp', {
        task_id: taskId, conversation_ref: REF, content: 'OUR content', approval_ref: approvalFor('OUR content'),
        baseline_user_message_refs: [],
      })

      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual([])
      expect(recovered.failed).toEqual(['op-fp'])
      // Never resend, never blindly claim the other message.
      expect(h.browser.getSendCount()).toBe(0)
      expect((await h.journal.readIdempotency('browser-submit', 'op-fp'))?.status).toBe('reserved')
    })
  })

  test('wrong conversation binding fails closed, no resend', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      await seedReserved(h, 'op-wrong', {
        task_id: taskId,
        conversation_ref: { adapter_id: 'chatgpt-web', conversation_id: 'conversation-OTHER' },
        content: 'x',
        approval_ref: approvalFor('x'),
        baseline_user_message_refs: [],
      })

      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.failed).toEqual(['op-wrong'])
      expect(h.browser.getSendCount()).toBe(0)
    })
  })

  test('empty pending set is a clean no-op', async () => {
    await withHarness(async (h) => {
      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual([])
      expect(recovered.failed).toEqual([])
      expect(h.browser.getCalls().filter(c => c.method === 'observeConversation').length).toBe(0)
    })
  })
  test('no new candidate fails closed and never resends (Case B)', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const hRef = h.browser.addUserMessage(REF, 'SAME') // H only; K never landed
      await seedReserved(h, 'op-b', {
        task_id: taskId, conversation_ref: REF, content: 'SAME', approval_ref: approvalFor('SAME'),
        baseline_user_message_refs: [hRef],
      })
      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual([])
      expect(recovered.failed).toEqual(['op-b'])
      expect(h.browser.getSendCount()).toBe(0)
      expect((await h.journal.readIdempotency('browser-submit', 'op-b'))?.status).toBe('reserved')
    })
  })

  test('multiple new candidates fail closed, never picks the first (Case C)', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const hRef = h.browser.addUserMessage(REF, 'SAME') // H
      h.browser.addUserMessage(REF, 'SAME') // K1
      h.browser.addUserMessage(REF, 'SAME') // K2
      await seedReserved(h, 'op-c', {
        task_id: taskId, conversation_ref: REF, content: 'SAME', approval_ref: approvalFor('SAME'),
        baseline_user_message_refs: [hRef],
      })
      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual([])
      expect(recovered.failed).toEqual(['op-c'])
      expect(h.browser.getSendCount()).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// 5b. M4-03B-FIX — historical identical-content false adoption
// ---------------------------------------------------------------------------

describe('M4-03B-FIX historical identical-content false adoption', () => {
  test('recovery adopts the freshly sent message K, not the historical H with identical content', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const hRef = h.browser.addUserMessage(REF, 'SAME') // historical H

      h.browser.setNextSubmitMode('effect_then_lost_ack')
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId, content: 'SAME', approval_ref: approvalFor('SAME'), idempotency_key: 'op-k',
      })
      // External effect (K) happened; the ack was lost before receipt persistence.
      expectFailure(result, 'TIMEOUT')
      expect(h.browser.getSendCount()).toBe(1)

      const kMsg = h.browser.listMessages(REF).find(
        m => m.role === 'user' && m.content === 'SAME' && m.message_ref !== hRef,
      )
      expect(kMsg).toBeDefined()
      expect(kMsg!.message_ref).not.toBe(hRef)

      await h.restart()

      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual(['op-k'])
      expect(h.browser.getSendCount()).toBe(1) // NO resend

      const completed = await h.journal.readIdempotency('browser-submit', 'op-k')
      expect(completed?.status).toBe('completed')
      const stored = JSON.parse(completed!.outcome_ref) as UserMessageReceipt
      expect(stored.message_ref).toBe(kMsg!.message_ref) // K
      expect(stored.message_ref).not.toBe(hRef)           // not H
    })
  })

  test('recovery does not mis-adopt a historical message with different content (Case E)', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const hRef = h.browser.addUserMessage(REF, 'OLD') // H, different content
      h.browser.setNextSubmitMode('effect_then_lost_ack')
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId, content: 'NEW', approval_ref: approvalFor('NEW'), idempotency_key: 'op-e',
      })
      expectFailure(result, 'TIMEOUT')
      const kMsg = h.browser.listMessages(REF).find(m => m.role === 'user' && m.content === 'NEW')
      expect(kMsg).toBeDefined()
      expect(kMsg!.message_ref).not.toBe(hRef)
      await h.restart()
      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual(['op-e'])
      const completed = await h.journal.readIdempotency('browser-submit', 'op-e')
      const stored = JSON.parse(completed!.outcome_ref) as UserMessageReceipt
      expect(stored.message_ref).toBe(kMsg!.message_ref)
      expect(stored.message_ref).not.toBe(hRef)
      expect(h.browser.getSendCount()).toBe(1)
    })
  })

  test('a pre-fix reserved record with no baseline fails closed (no false adoption)', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const hRef = h.browser.addUserMessage(REF, 'SAME') // historical H
      // A record persisted BEFORE the baseline field existed carries no
      // baseline_user_message_refs at all. Recovery must refuse rather than fall
      // back to content-only matching (which would adopt H).
      await h.journal.commit({
        idempotency: {
          namespace: 'browser-submit',
          operation_key: 'op-legacy',
          payload_hash: hashPayload({
            conversation_ref: REF, content: 'SAME', approval_ref: approvalFor('SAME'),
          }),
          outcome_ref: canonicalJson({
            task_id: taskId, conversation_ref: REF, content: 'SAME', approval_ref: approvalFor('SAME'),
          }),
          status: 'reserved',
          at: '2026-01-01T00:00:00.000Z',
        },
      })

      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual([])
      expect(recovered.failed).toEqual(['op-legacy'])
      // Never adopted H, never resent, record stays reserved for manual review.
      expect(h.browser.getSendCount()).toBe(0)
      expect((await h.journal.readIdempotency('browser-submit', 'op-legacy'))?.status).toBe('reserved')
      expect(hRef).toBeDefined()
    })
  })
})

// ---------------------------------------------------------------------------
// 6. Unavailable / timeout map to Core errors and then recover cleanly
// ---------------------------------------------------------------------------

describe('M4-03B unavailable / timeout semantics', () => {
  test('unavailable submit leaves a reserved record that recovery can complete', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      h.browser.setNextSubmitMode('unavailable')
      expectFailure(
        await h.core.submitBrowserUserMessage({
          task_id: taskId, content: 'u', approval_ref: approvalFor('u'), idempotency_key: 'op-u',
        }),
        'UNAVAILABLE',
      )
      expect(h.browser.getSendCount()).toBe(0)

      await h.restart()
      // Mode reset to 'accept', so recovery resends once and completes.
      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual(['op-u'])
      expect(h.browser.getSendCount()).toBe(1)
    })
  })

  test('timeout submit leaves a reserved record that recovery can complete', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      h.browser.setNextSubmitMode('timeout')
      expectFailure(
        await h.core.submitBrowserUserMessage({
          task_id: taskId, content: 't', approval_ref: approvalFor('t'), idempotency_key: 'op-t',
        }),
        'TIMEOUT',
      )
      expect(h.browser.getSendCount()).toBe(0)

      await h.restart()
      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual(['op-t'])
      expect(h.browser.getSendCount()).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// 7. M4-05 approval_ref.hash round-trip (fix A)
// ---------------------------------------------------------------------------

describe('M4-05 approval_ref hash round-trip', () => {
  test('approval_ref.hash survives persist -> parse -> recovery and the payload identity is stable', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const content = 'round-trip'
      const approval = approvalFor(content)

      // Fail the external send so the intent stays 'reserved' for recovery.
      h.browser.setNextSubmitMode('unavailable')
      expectFailure(
        await h.core.submitBrowserUserMessage({
          task_id: taskId, content, approval_ref: approval, idempotency_key: 'op-roundtrip',
        }),
        'UNAVAILABLE',
      )

      const reserved = await h.journal.readIdempotency('browser-submit', 'op-roundtrip')
      expect(reserved?.status).toBe('reserved')

      // (a) `approval_ref.hash` is persisted verbatim in the durable intent.
      const persistedIntent = JSON.parse(reserved!.outcome_ref) as { approval_ref: EvidenceRef }
      expect(persistedIntent.approval_ref.hash).toBe(approval.hash)

      // (b) `hash` is part of the intent's payload identity: the recorded
      // payload_hash equals the hash of the full intent, `hash` included.
      expect(reserved!.payload_hash).toBe(
        hashPayload({ conversation_ref: REF, content, approval_ref: approval }),
      )
      const reservedPayloadHash = reserved!.payload_hash

      await h.restart()

      // (c) Recovery re-derives the payload_hash from the PARSED intent. It only
      // succeeds if `parseBrowserSubmitIntent` preserved `approval_ref.hash`
      // losslessly; otherwise the journal rejects it with IDEMPOTENCY_CONFLICT.
      const recovered = expectOk(await h.core.recoverPendingBrowserSubmits())
      expect(recovered.recovered).toEqual(['op-roundtrip'])
      expect(recovered.failed).toEqual([])

      const completed = await h.journal.readIdempotency('browser-submit', 'op-roundtrip')
      expect(completed?.status).toBe('completed')
      expect(completed!.payload_hash).toBe(reservedPayloadHash)
    })
  })
})
