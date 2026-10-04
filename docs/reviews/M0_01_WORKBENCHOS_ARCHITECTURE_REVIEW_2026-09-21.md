# M0-01 — WorkbenchOS Architecture Review

Project: WorkbenchOS  
Review ID: M0-01-R1  
Review Type: Architecture Review of Codex Baseline Audit  
Review Date: 2026-09-21  
Reviewed Artifact: `docs/audits/M0_01_CODEX_CC_HAHA_BASELINE_AUDIT_2026-09-21.md`

## Review Decision

**ACCEPT WITH SCOPE REDUCTION**

The Codex audit is accepted as the current architecture evidence baseline.

Its three central conclusions are accepted:

1. WorkbenchOS must own its own Task / Run / Approval / Recovery / Audit control-plane state.
2. The initial orchestrator should live as an isolated module owned by the existing cc-haha local server, while ChatGPT Web-specific browser logic remains in Electron main.
3. WorkbenchOS core must depend on narrow, versioned compatibility ports rather than cc-haha high-churn internals.

However, the Codex-proposed “first implementation slice” is too broad for the first code change.

The next step is therefore NOT to implement the full ChatGPT Web → runtime → result loop.

The next step is to freeze the minimum M1 contracts and state ownership, then implement the core with fake adapters before touching the real browser/runtime seams.

---

# 1. FACT — Accepted Evidence

Based on the Codex audit artifact:

- cc-haha already provides the desktop/runtime shell required for the project:
  - Electron desktop
  - local Bun server
  - WebSocket/session infrastructure
  - CLI process execution
  - Git/worktree capability
  - browser runtime
  - permission flows
- The browser is Electron-main-owned and currently uses `WebContentsView`.
- Browser state, session state, CLI task state, workflow state, and WorkbenchOS task state do not share the same lifecycle.
- cc-haha internal hotspots such as `src/server/ws/handler.ts`, `conversationService.ts`, and `sessionService.ts` are high-churn and should not become direct WorkbenchOS core dependencies.
- Browser cookies/login state should remain opaque to WorkbenchOS.
- cc-haha Session cannot safely be treated as WorkbenchOS Task.
- A server-owned isolated WorkbenchOS module is a viable initial placement.
- A ChatGPT-specific browser adapter belongs on the Electron side, not inside the WorkbenchOS core.
- The current local checkout remained clean throughout the audit.

These facts are accepted as the working baseline unless contradicted by later code-level validation.

---

# 2. INFERENCE — Architecture Interpretation

The audit supports the following system boundary:

```text
WorkbenchOS Control Plane
│
├─ Task / Run identity
├─ State machine
├─ Idempotency
├─ Approval projection
├─ Recovery checkpoints
├─ Artifact / evidence manifest
├─ Audit events
│
├─ AgentPort
├─ BrowserAutomationPort
├─ WorkspacePort
└─ PermissionPort
        │
        ▼
Compatibility / Integration Layer
        │
        ├─ CcHahaRuntimeAdapter
        └─ ChatGPTWebAdapter
                │
                ▼
              cc-haha
```

cc-haha remains the runtime foundation, not the WorkbenchOS source of truth.

WorkbenchOS should store references to cc-haha-owned evidence rather than copy or reinterpret cc-haha internal state whenever possible.

---

# 3. ACCEPTED Architecture Decisions

## A. Independent Workbench Task / Run identity

Accepted.

Minimum identity must distinguish:

- `project_id`
- `task_id`
- `run_id`
- `conversation_id`
- `native_session_id` or equivalent runtime locator
- `agent_id`
- `protocol_version`

A Task may have multiple Runs.

A cc-haha Session may not be assumed to map 1:1 to a Workbench Task.

## B. Server-owned WorkbenchOS core

Accepted for M1.

Use an isolated internal server module rather than a separate sidecar.

Reason:

- lower startup complexity
- reuse existing server lifecycle
- reuse local API/auth plumbing
- easier initial testing
- still separable later if boundaries remain explicit

This is an M1 decision, not a permanent prohibition on a future sidecar.

## C. Electron-owned ChatGPT Web adapter

Accepted.

ChatGPT page-specific logic must stay outside the core.

The core should receive normalized browser events and issue typed browser commands.

## D. Versioned compatibility boundary

Accepted as a hard requirement.

WorkbenchOS core must not directly depend on:

- `ws/handler.ts` private maps
- raw CLI stream-json message shapes
- cc-haha JSONL file layouts
- cc-haha SQLite projection schemas
- Electron `WebContentsView`
- cookie/session internals
- provider-specific environment variables

## E. Upstream-first compatibility policy

Accepted.

When WorkbenchOS needs a missing cc-haha capability:

1. Prefer an existing public/internal seam.
2. Otherwise add the smallest generic hook/facade.
3. Keep WorkbenchOS policy out of cc-haha core.
4. Consider a generic upstream PR when practical.
5. Avoid embedding Workbench-specific semantics in high-churn upstream files.

---

# 4. REVISIONS to Codex Proposal

## Revision 1 — The proposed first implementation slice is too large

Codex proposed a slice containing:

- ChatGPT adapter
- Workbench journal
- runtime adapter
- result return
- idempotency
- failure evidence
- fake browser/runtime tests

This is too much for the first implementation change.

It crosses browser, Electron IPC, server core, persistence, runtime execution, permissions, and protocol boundaries simultaneously.

That would make regressions and architectural mistakes difficult to isolate.

### Revised sequence

The first code slice should not touch the real ChatGPT page or real cc-haha runtime.

Use:

```text
Contract
→ Core state machine
→ Durable journal
→ Fake AgentPort
→ Deterministic tests
```

Only after that contract is validated should the first real cc-haha adapter be added.

## Revision 2 — Do not freeze a broad final protocol yet

The audit recommends freezing versioned ports and envelopes.

Accepted only for the minimum M1 contract.

Do not attempt to design the final multi-agent protocol in M0.

Freeze only fields required for:

```text
one ChatGPT conversation
→ one Workbench Task
→ one Run
→ one execution agent
→ one Result
```

Schemas must remain explicitly versioned and extensible.

## Revision 3 — Approval is a boundary before it is a full subsystem

For M1, approval must be represented in the Task/Run state model, but a general-purpose Approval Engine is not required yet.

Minimum M1 requirement:

- explicit required approval type
- pending/approved/denied state
- actor/source
- timestamp
- audit event
- no implicit commit/push

Do not build generalized policy automation in the first slice.

## Revision 4 — Browser automation should be delayed until deterministic core tests exist

The real ChatGPT DOM is an unstable external dependency.

Before browser work, WorkbenchOS should already be able to prove:

```text
TaskEnvelope
→ accepted once
→ Run created once
→ fake agent invoked once
→ Result recorded once
→ duplicate input does not execute twice
→ restart reconstructs state
```

This becomes the contract that the ChatGPT adapter and cc-haha runtime adapter must satisfy.

---

# 5. Source-of-Truth Decision

## WorkbenchOS-owned source of truth

WorkbenchOS owns:

- project/task/run identity
- task/run lifecycle
- idempotency keys
- Workbench approval state
- recovery checkpoints
- decision records
- artifact/evidence manifest
- audit events

## cc-haha-owned source of truth

cc-haha remains authoritative for:

- native session/transcript
- CLI-owned task state
- native workflow/team/mailbox state
- browser cookie/login partition
- Git/worktree metadata
- cc-haha indexes/projections
- native runtime process state

## Rule

WorkbenchOS stores locators/references to cc-haha-owned state.

It must not create a second copy of the same authority unless a recovery requirement explicitly justifies a projection.

---

# 6. M1 Minimal State Model — To Freeze Next

The next design task should define only these concepts.

## WorkbenchTask

Minimum responsibilities:

- stable task identity
- project/repository identity
- ChatGPT conversation identity
- goal/context/scope
- requested agent/model
- approval requirements
- validation requirement
- stop condition
- protocol version

## WorkbenchRun

Minimum responsibilities:

- stable run identity
- parent task identity
- native runtime/session locator
- execution status
- timestamps
- idempotency key
- result reference
- error/recovery state

## ResultEnvelope

Minimum responsibilities:

- task/run identity
- normalized outcome
- changed files
- commands
- tests/results
- validation evidence
- Git state
- artifacts
- risks/unresolved work
- next action

## EventEnvelope

Minimum responsibilities:

- protocol version
- event ID
- task ID
- run ID where applicable
- event type
- timestamp
- payload
- producer
- idempotency/deduplication metadata

---

# 7. M1 State Machine — Minimum Scope

Do not over-generalize.

A first candidate:

```text
Task:
CREATED
→ READY
→ RUNNING
→ WAITING_REVIEW
→ COMPLETED

Failure branches:
→ BLOCKED
→ FAILED
→ CANCELLED
```

Run:

```text
CREATED
→ SUBMITTED
→ RUNNING
→ WAITING_APPROVAL
→ SUCCEEDED

Failure branches:
→ FAILED
→ CANCELLED
→ TIMED_OUT
```

Exact transitions are NOT frozen by this review.

They must be validated in the next contract-design task.

---

# 8. Upstream Compatibility Rules

The following are architecture invariants:

1. New WorkbenchOS logic should primarily live in new modules.
2. Existing cc-haha high-churn files should receive registration/hooks only where necessary.
3. WorkbenchOS policy must not be inserted into generic cc-haha runtime internals.
4. Every upstream sync must run compatibility/contract tests.
5. cc-haha internal identifiers must be wrapped before entering WorkbenchOS core.
6. No WorkbenchOS core type may expose `WebContentsView` or raw CLI stream-json types.
7. Browser credentials/cookies remain opaque.
8. If a required seam does not exist, prefer a tiny generic hook over copying/forking the implementation.

---

# 9. Risk Review

## P1 — Premature full-loop implementation

If browser, runtime, persistence and protocol are implemented in one slice, failure location becomes ambiguous.

Mitigation:
build deterministic core first.

## P1 — Dual source of truth

If Workbench Task state is inferred from cc-haha Session or CLI Task state, recovery becomes unreliable.

Mitigation:
explicit Workbench Task/Run journal with references to native state.

## P1 — Upstream merge cost

Direct edits to `ws/handler.ts`, `conversationService.ts`, or other high-churn internals will create recurring conflicts.

Mitigation:
compatibility facade + new modules + minimal registration hooks.

## P1 — Browser duplication/replay

Page refresh or reconnect may replay the same task/result.

Mitigation:
idempotency defined in the core before browser integration.

## P2 — Over-designed protocol

Trying to freeze multi-agent/future automation concepts too early may harden wrong assumptions.

Mitigation:
freeze only M1 fields proven necessary by the one-agent loop.

---

# 10. Review Outcome

## ACCEPT

- cc-haha as WorkbenchOS runtime foundation
- independent Workbench Task/Run control plane
- server-owned core for M1
- Electron-owned ChatGPT adapter
- narrow versioned ports
- independent durable Workbench journal
- references instead of duplicated native state
- explicit upstream compatibility boundary

## MODIFY

- reduce first implementation slice
- freeze only minimal M1 schema
- defer real ChatGPT browser integration until deterministic core exists
- defer generalized approval engine
- defer additional agent adapters

## REJECT FOR M1

- full autonomous orchestration
- multi-agent routing
- cron-based execution
- implicit `bypassPermissions`
- automatic commit/push
- direct Workbench core dependency on cc-haha private/high-churn internals
- broad protocol/framework design beyond the first real workflow

---

# 11. Next Action

Proceed to **M0-02 — M1 Contract & State Model Freeze**.

M0-02 should be Analysis/Design only.

Its output should define:

1. M1 TaskEnvelope V0.1
2. M1 ResultEnvelope V0.1
3. M1 EventEnvelope V0.1
4. WorkbenchTask / WorkbenchRun lifecycle
5. idempotency rules
6. approval representation
7. persistence ownership
8. AgentPort V0.1
9. BrowserAutomationPort V0.1
10. CcHahaRuntimeAdapter boundary
11. recovery invariants
12. contract-test plan

No implementation should begin until M0-02 is reviewed.

---

# 12. Commit Decision

**DO NOT COMMIT IMPLEMENTATION CODE YET.**

The Codex audit artifact and this review artifact may be committed later as documentation after:

- their paths are verified,
- repository status is reviewed,
- no unrelated files are present,
- the user explicitly authorizes the documentation commit.

No commit or push is authorized by this review.
