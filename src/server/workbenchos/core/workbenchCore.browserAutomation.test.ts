/**
 * M4-03A integration & contract tests: BrowserAutomationPort v0.1 wired into
 * WorkbenchCore.
 *
 * These run fully offline against the deterministic FakeBrowserAutomationPort
 * (M4-02A). They prove:
 *   - Core can call the REAL adapter shape through the FROZEN port interface
 *   - conversation_ref is sourced from the Task envelope
 *   - approval_ref is passed through (never mapped to bypassPermissions)
 *   - idempotencyKey is operation-level, not content-level dedup
 *   - the receipt lands in the journal as an operation-level idempotency record
 *   - BrowserAutomation failures map onto the EXISTING CoreErrorCode taxonomy
 *   - Core depends only on the frozen port, never on adapter internals
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteJournal } from '../persistence/sqliteJournal.js'
import {
  WorkbenchCore,
  type Clock,
  type CoreResult,
  type CreateTaskInput,
} from './workbenchCore.js'
import { FakeAgentPort } from '../testing/fakeAgentPort.js'
import { FakeBrowserAutomationPort } from '../testing/fakeBrowserAutomationPort.js'
import type { ConversationRef, EvidenceRef, UserMessageReceipt } from '../ports/browserAutomationPort.js'
import { externalBrowserSubmitActionFingerprint } from './deliveryApproval.js'

type Harness = {
  journal: SqliteJournal
  browser: FakeBrowserAutomationPort
  core: WorkbenchCore
}

const REF: ConversationRef = { adapter_id: 'chatgpt-web', conversation_id: 'conversation-1' }

// M4-05: builds a valid `external_browser_submit` approval bound to the exact
// (content, conversation) action this task will submit.
function approvalFor(content: string, ref: ConversationRef = REF): EvidenceRef {
  return {
    kind: 'external_browser_submit',
    ref: 'apr-1',
    hash: externalBrowserSubmitActionFingerprint({ conversation_ref: ref, content }),
  }
}

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
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-browser-'))
  const journal = new SqliteJournal({ databasePath: join(dir, 'workbench.sqlite3') })
  await journal.open()
  const agent = new FakeAgentPort()
  const browser = new FakeBrowserAutomationPort()
  const core = new WorkbenchCore({
    journal,
    agentPort: agent,
    browserAutomation: browser,
    clock: makeClock(),
    ids: makeIds(),
    project_id: 'project-1',
    port_timeout_ms: 1000,
  })
  try {
    await run({ journal, browser, core })
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M4-03A browser automation wiring', () => {
  test('healthCheck success surfaces availability and capabilities', async () => {
    await withHarness(async (h) => {
      const result = await h.core.checkBrowserAutomationHealth()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.available).toBe(true)
      expect(result.value.capabilities).toContain('fake-browser')
    })
  })

  test('healthCheck UNAVAILABLE maps to Core UNAVAILABLE', async () => {
    await withHarness(async (h) => {
      h.browser.injectFault('health_unavailable')
      const result = await h.core.checkBrowserAutomationHealth()
      expectFailure(result, 'UNAVAILABLE')
    })
  })

  test('observeBrowserConversation returns messages for the task conversation', async () => {
    await withHarness(async (h) => {
      h.browser.addAssistantMessage(REF, 'hello there', true)
      const taskId = await createReadyTask(h)
      const result = await h.core.observeBrowserConversation(taskId)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.messages.map(m => m.role)).toContain('assistant')
      expect(result.value.messages.some(m => m.content === 'hello there')).toBe(true)
    })
  })

  test('observeBrowserConversation NOT_FOUND maps to Core NOT_FOUND', async () => {
    await withHarness(async (h) => {
      h.browser.injectFault('observe_not_found')
      const taskId = await createReadyTask(h)
      const result = await h.core.observeBrowserConversation(taskId)
      expectFailure(result, 'NOT_FOUND')
    })
  })

  test('observeBrowserConversation TIMEOUT maps to Core TIMEOUT', async () => {
    await withHarness(async (h) => {
      h.browser.injectFault('observe_timeout')
      const taskId = await createReadyTask(h)
      const result = await h.core.observeBrowserConversation(taskId)
      expectFailure(result, 'TIMEOUT')
    })
  })

  test('submitBrowserUserMessage success records receipt into the journal', async () => {
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
      expect(result.value.receipt.content_fingerprint).toContain('fp:')

      // receipt enters the journal as an operation-level idempotency record
      const record = await h.journal.readIdempotency('browser-submit', 'op-1')
      expect(record).not.toBeNull()
      expect(record?.status).toBe('completed')
      const stored = JSON.parse(record!.outcome_ref) as UserMessageReceipt
      expect(stored.message_ref).toBe(result.value.receipt.message_ref)
      expect(h.browser.getSendCount()).toBe(1)
    })
  })

  test('submitBrowserUserMessage empty approval_ref → PERMISSION_REQUIRED (no send)', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId,
        content: 'x',
        approval_ref: { kind: 'approval', ref: '' },
        idempotency_key: 'op-perm',
      })
      expectFailure(result, 'PERMISSION_REQUIRED')
      expect(h.browser.getSendCount()).toBe(0)
    })
  })

  test('submitBrowserUserMessage port PERMISSION_REQUIRED maps through', async () => {
    await withHarness(async (h) => {
      h.browser.setNextSubmitMode('permission')
      const taskId = await createReadyTask(h)
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId,
        content: 'x',
        approval_ref: approvalFor('x'),
        idempotency_key: 'op-perm2',
      })
      expectFailure(result, 'PERMISSION_REQUIRED')
    })
  })

  test('submitBrowserUserMessage UNAVAILABLE maps to Core UNAVAILABLE without send', async () => {
    await withHarness(async (h) => {
      h.browser.setNextSubmitMode('unavailable')
      const taskId = await createReadyTask(h)
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId,
        content: 'x',
        approval_ref: approvalFor('x'),
        idempotency_key: 'op-una',
      })
      expectFailure(result, 'UNAVAILABLE')
      expect(h.browser.getSendCount()).toBe(0)
    })
  })

  test('submitBrowserUserMessage TIMEOUT maps to Core TIMEOUT', async () => {
    await withHarness(async (h) => {
      h.browser.setNextSubmitMode('timeout')
      const taskId = await createReadyTask(h)
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId,
        content: 'x',
        approval_ref: approvalFor('x'),
        idempotency_key: 'op-to',
      })
      expectFailure(result, 'TIMEOUT')
    })
  })

  test('submitBrowserUserMessage NOT_FOUND maps to Core NOT_FOUND', async () => {
    await withHarness(async (h) => {
      h.browser.setNextSubmitMode('not_found')
      const taskId = await createReadyTask(h)
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId,
        content: 'x',
        approval_ref: approvalFor('x'),
        idempotency_key: 'op-nf',
      })
      expectFailure(result, 'NOT_FOUND')
    })
  })

  test('submitBrowserUserMessage IDEMPOTENCY_CONFLICT maps to Core IDEMPOTENCY_CONFLICT', async () => {
    await withHarness(async (h) => {
      h.browser.setNextSubmitMode('idempotency_conflict')
      const taskId = await createReadyTask(h)
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId,
        content: 'x',
        approval_ref: approvalFor('x'),
        idempotency_key: 'op-conf',
      })
      expectFailure(result, 'IDEMPOTENCY_CONFLICT')
    })
  })

  test('idempotencyKey is operation-level, not content-level dedup', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)

      // Same content, two distinct operation keys → two real sends (no content dedup).
      await expectOk(await h.core.submitBrowserUserMessage({
        task_id: taskId, content: 'same text', approval_ref: approvalFor('same text'), idempotency_key: 'op-a',
      }))
      await expectOk(await h.core.submitBrowserUserMessage({
        task_id: taskId, content: 'same text', approval_ref: approvalFor('same text'), idempotency_key: 'op-b',
      }))
      expect(h.browser.getSendCount()).toBe(2)

      // Same operation key → no second send; receipt is stable and journal-consistent.
      const againApproval = approvalFor('again')
      const first = expectOk(await h.core.submitBrowserUserMessage({
        task_id: taskId, content: 'again', approval_ref: againApproval, idempotency_key: 'op-c',
      }))
      const second = expectOk(await h.core.submitBrowserUserMessage({
        task_id: taskId, content: 'again', approval_ref: againApproval, idempotency_key: 'op-c',
      }))
      expect(h.browser.getSendCount()).toBe(3)
      expect(second.receipt.message_ref).toBe(first.receipt.message_ref)

      const record = await h.journal.readIdempotency('browser-submit', 'op-c')
      const stored = JSON.parse(record!.outcome_ref) as UserMessageReceipt
      expect(stored.message_ref).toBe(second.receipt.message_ref)
    })
  })

  test('Core depends only on the frozen BrowserAutomationPort interface', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'workbenchCore.ts'), 'utf8')
    const forbidden = ['ChatGPT', 'CDP', 'WebContentsView', 'selector', 'electron', 'bypassPermissions', 'driver']
    for (const token of forbidden) {
      expect(source.includes(token), `source must not contain ${token}`).toBe(false)
    }
    // Only the frozen port interface is imported; never the desktop adapter or CDP internals.
    expect(source).not.toMatch(/from\s+['"][^'"]*chatgptBrowser/)
    expect(source).not.toMatch(/from\s+['"]desktop/)
    const portImports = source.match(/from\s+['"]\.\.\/ports\/browserAutomationPort\.js['"]/g) ?? []
    expect(portImports.length).toBeGreaterThanOrEqual(1)
  })

  test('submitBrowserUserMessage wrong approval kind → PERMISSION_REQUIRED (no send)', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId,
        content: 'x',
        approval_ref: {
          kind: 'approval',
          ref: 'apr-1',
          hash: externalBrowserSubmitActionFingerprint({ conversation_ref: REF, content: 'x' }),
        },
        idempotency_key: 'op-kind',
      })
      expectFailure(result, 'PERMISSION_REQUIRED')
      expect(h.browser.getSendCount()).toBe(0)
    })
  })

  test('submitBrowserUserMessage missing hash → PERMISSION_REQUIRED (no send)', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId,
        content: 'x',
        approval_ref: { kind: 'external_browser_submit', ref: 'apr-1' },
        idempotency_key: 'op-nohash',
      })
      expectFailure(result, 'PERMISSION_REQUIRED')
      expect(h.browser.getSendCount()).toBe(0)
    })
  })

  test('submitBrowserUserMessage hash for a different content → PERMISSION_REQUIRED (no send)', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId,
        content: 'x',
        approval_ref: approvalFor('other'),
        idempotency_key: 'op-othercontent',
      })
      expectFailure(result, 'PERMISSION_REQUIRED')
      expect(h.browser.getSendCount()).toBe(0)
    })
  })

  test('submitBrowserUserMessage hash for a different conversation → PERMISSION_REQUIRED (no send)', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const otherRef: ConversationRef = { adapter_id: 'chatgpt-web', conversation_id: 'conversation-2' }
      const result = await h.core.submitBrowserUserMessage({
        task_id: taskId,
        content: 'x',
        approval_ref: approvalFor('x', otherRef),
        idempotency_key: 'op-otherconv',
      })
      expectFailure(result, 'PERMISSION_REQUIRED')
      expect(h.browser.getSendCount()).toBe(0)
    })
  })
})
