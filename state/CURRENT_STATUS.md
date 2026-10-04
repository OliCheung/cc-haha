# WorkbenchOS — CURRENT_STATUS

Updated: 2026-09-22  
Project: WorkbenchOS  
Phase: M0 Architecture Complete / Preparing M1-001  
Status: ARCHITECTURE COMPLETE — M1-001 IMPLEMENTATION NOT YET AUTHORIZED (awaiting Git + Bun toolchain preflight)  

## 1. Project Goal

WorkbenchOS is a local-first, artifact-first, agent-neutral AI development control plane built on top of cc-haha as the first runtime/execution foundation.

Target loop:

```text
ChatGPT Web
→ structured Workbench Task
→ WorkbenchOS Orchestrator
→ execution agent
→ implementation / test
→ structured Result
→ WorkbenchOS
→ ChatGPT Web
→ review / next task
```

The project goal is to reduce manual copy/paste while preserving:

- traceability
- recoverability
- Git safety
- explicit human approval
- agent replaceability
- durable task/result artifacts
- compatibility with future cc-haha upstream upgrades

## 2. Repository Baseline

Local repository:

```text
M:\vibecoding\Projects\WorkbenchOS
```

Git relationship:

```text
origin   → https://github.com/OliCheung/cc-haha.git
upstream → https://github.com/NanmiCoder/cc-haha.git
```

Verified M0 baseline:

- branch: `main`
- baseline HEAD: `b8c7a115`
- `main...origin/main`: aligned at M0 review time
- `main...upstream/main`: `0 / 0` at M0 review time
- tracked working tree: clean at M0 review time
- architecture documents are currently expected to be local untracked files until an explicit documentation commit is authorized

Before any implementation, Git state must be re-verified.

## 3. M0 Completed Work

### M0-01 — cc-haha Baseline & Extension-Point Audit

Completed.

Key findings:

- cc-haha already provides the runtime shell needed by WorkbenchOS:
  - Electron desktop
  - local Bun server
  - WebSocket/session infrastructure
  - CLI execution
  - Git/worktree support
  - browser runtime
  - permission flows
- WorkbenchOS should reuse cc-haha rather than reimplement these systems.
- Workbench Task must not be equated with cc-haha Session or CLI Task.
- High-churn cc-haha internals must not become direct WorkbenchOS core dependencies.

### M0-01 Architecture Review

Decision:

`ACCEPT WITH SCOPE REDUCTION`

Accepted:

- independent Workbench control plane
- server-owned Workbench core for M1
- Electron-owned ChatGPT Web adapter
- narrow compatibility boundaries
- cc-haha remains runtime foundation

### M0-02 — M1 Contract & State Model

Completed.

Designed:

- identity model
- TaskEnvelope V0.1
- ResultEnvelope V0.1
- EventEnvelope V0.1
- Task / Run lifecycle
- idempotency rules
- approval representation
- SQLite persistence direction
- AgentPort V0.1
- BrowserAutomationPort V0.1
- recovery invariants
- deterministic contract-test plan

### M0-02 Contract Review

Decision:

`ACCEPT WITH MINOR REVISIONS`

Important revision:

Do not overbuild event sourcing or browser automation in M1.

### M0-03 — First Coding Slice Implementation Architecture

Completed.

Recommended first implementation:

```text
src/server/workbenchos/
```

with:

- contracts
- Task/Run pure reducers
- idempotency primitives
- JournalPort
- SQLite journal/current projections
- thin WorkbenchCore
- FakeAgentPort
- deterministic tests

No production runtime registration.

### M0-03 Implementation Review

Decision:

`ACCEPT WITH CONDITIONS`

M0 architecture planning is complete enough to begin the first isolated coding slice.

## 4. Frozen Architecture

### WorkbenchOS Owns

- `project_id`
- `task_id`
- `run_id`
- Workbench Task/Run lifecycle
- idempotency
- business approval state
- recovery checkpoints
- result/evidence references
- audit events
- Workbench persistence

### cc-haha Owns

- native session/transcript
- CLI-owned runtime state
- workflow/team/mailbox state
- browser login/cookie partition
- Git/worktree metadata
- native process/runtime state
- cc-haha indexes and projections

WorkbenchOS should reference cc-haha-owned evidence rather than copy native authority.

## 5. Key Architecture Boundaries

### Core must not directly depend on

- `src/server/ws/handler.ts`
- raw CLI stream-json
- cc-haha JSONL layouts
- cc-haha SQLite projection schemas
- Electron `WebContentsView`
- browser cookie/session internals
- provider-specific environment variables

### First coding slice must not modify

- `src/server/index.ts`
- `src/server/router.ts`
- `src/server/ws/handler.ts`
- `src/server/ws/events.ts`
- `src/server/services/conversationService.ts`
- `src/server/services/sessionService.ts`
- `src/server/services/repositoryLaunchService.ts`
- `desktop/**`

The only existing-file changes potentially allowed in M1-001 are narrow persistence quality-gate routing changes, and only after revalidation:

- `scripts/pr/change-policy.ts`
- `scripts/pr/change-policy.test.ts`
- `scripts/quality-gate/persistence-upgrade.ts`

## 6. Persistence Direction

M1 persistence:

```text
SQLite events
+
current Task/Run/Result projections
+
idempotency records
+
recovery checks
```

Do not build a general event-sourcing framework.

Hard rule:

```text
persist side-effect intent
→ commit DB transaction
→ execute AgentPort side effect
→ persist receipt/reconciliation
```

Never hold a SQLite transaction open while invoking an execution agent.

## 7. First Coding Slice

Next implementation task:

**M1-001 — WorkbenchOS Isolated Core Foundation**

M1 architecture planning is complete, but implementation is not yet authorized. Before M1-001 may modify code, Git state must be re-verified and the Bun toolchain preflight must pass (see §8 and `docs/validation/M1_001_CODEBUDDY_PREFLIGHT_VALIDATION_2026-09-22.md`).

Expected scope:

```text
contracts
+
Task/Run reducers
+
SQLite journal/current projections
+
idempotency primitives
+
JournalPort
+
thin WorkbenchCore
+
FakeAgentPort
+
deterministic contract tests
+
narrow persistence quality-gate routing
```

Explicitly excluded:

- real cc-haha runtime adapter
- ChatGPT Web adapter
- Electron IPC
- browser/DOM logic
- server API registration
- multi-agent routing
- scheduling
- automatic Git commit/push
- production database path

## 8. Required Preconditions Before M1-001

### Git

Re-verify:

```text
repository path
branch
HEAD
origin
upstream
working tree
ahead/behind
expected file scope
```

### Bun

M1-001 requires:

- Bun test runner
- `bun:sqlite`
- repository quality gates

Required:

```text
bun --version
```

If Bun is unavailable:

**STOP. Do not install automatically.**

### Documentation baseline

Current M0 artifacts should be distinguished from implementation changes.

Preferred next Git action:

- review all M0 documentation files
- optionally make one documentation-only baseline commit
- only after explicit user authorization

No commit or push is currently authorized.

## 9. M1-001 Validation Contract

At minimum implementation must prove:

1. Task validation
2. `task.created → CREATED → task.ready → READY`
3. Run creation
4. valid state transitions
5. invalid transition rejection
6. duplicate Task ingestion
7. duplicate native submission prevention
8. duplicate Result acceptance
9. conflicting Result rejection
10. FakeAgentPort success
11. FakeAgentPort failure
12. cancellation
13. timeout/recovery ambiguity
14. restart recovery
15. transaction rollback
16. schema reopen
17. future schema fail-closed
18. dependency boundary enforcement
19. persistence quality-gate routing

## 10. Current Risks

### P1

- duplicate native execution after crash
- dual authority between WorkbenchOS and cc-haha
- approval/tool-permission conflation
- future browser duplicate delivery
- accidental coupling to high-churn upstream internals

### P2

- Windows SQLite locking/corruption handling
- schema evolution
- browser DOM churn
- native runtime state loss across restart

## 11. Current Blockers / Open Questions

Not blocking isolated M1-001:

- final production database root
- real cc-haha durable submission lookup
- real ChatGPT delivery verification after reload/crash
- production corruption-repair UX

These block later runtime/browser integration, not the isolated core.

## 12. Source Artifacts

### Audits

- `docs/audits/M0_01_CODEX_CC_HAHA_BASELINE_AUDIT_2026-09-21.md`

### Design / Codex Reports

- `docs/design/M0_02_CODEX_M1_CONTRACT_STATE_MODEL_FREEZE_2026-09-22.md`
- `docs/design/M0_03_CODEX_FIRST_CODING_SLICE_IMPLEMENTATION_PLAN_2026-09-22.md`

### Reviews

- `docs/reviews/M0_01_WORKBENCHOS_ARCHITECTURE_REVIEW_2026-09-21.md`
- `docs/reviews/M0_02_WORKBENCHOS_CONTRACT_ARCHITECTURE_REVIEW_2026-09-22.md`
- `docs/reviews/M0_03_WORKBENCHOS_IMPLEMENTATION_ARCHITECTURE_REVIEW_2026-09-22.md`

### Validation

- `docs/validation/M1_001_CODEBUDDY_PREFLIGHT_VALIDATION_2026-09-22.md`
- `docs/validation/M0_04_WORKBENCHOS_DOCUMENTATION_COMPLETENESS_REPORT_2026-09-22.md`
- `docs/validation/M0_04_1_DOCUMENTATION_ALIGNMENT_REPORT_2026-09-22.md`

## 13. Next Recommended Action

1. Save this file as `state/CURRENT_STATUS.md`.
2. Save the project decision log.
3. Inspect Git status.
4. Verify Bun.
5. Decide whether to create a documentation-only M0 baseline commit.
6. Generate and execute M1-001 only after the preconditions pass.

No implementation commit or push is authorized.
