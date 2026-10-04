# WorkbenchOS — DECISION_LOG

Project: WorkbenchOS  
Created: 2026-09-22  
Purpose: Stable architecture and workflow decisions.

This file records accepted decisions.

Raw Codex reports are evidence.
Review documents explain the reasoning.
This Decision Log is the concise source for decisions that should be reused without re-investigation unless new evidence invalidates them.

---

## D-001 — WorkbenchOS Uses cc-haha as Runtime Foundation

Status: ACCEPTED  
Phase: M0-01

Decision:

WorkbenchOS will be built on top of cc-haha rather than reimplementing desktop, browser, terminal, session, Git/worktree, and agent-runtime infrastructure.

WorkbenchOS remains a distinct control-plane architecture.

Rationale:

cc-haha already provides substantial runtime infrastructure that WorkbenchOS would otherwise need to build from scratch.

Constraint:

WorkbenchOS must remain separable enough that the runtime can theoretically be replaced in the future.

---

## D-002 — Maintain an Upstream-Friendly Fork

Status: ACCEPTED  
Phase: M0-01

Decision:

Git relationship:

```text
NanmiCoder/cc-haha
      ↑ upstream

OliCheung/cc-haha
      ↑ origin

local WorkbenchOS checkout
```

WorkbenchOS should continuously absorb upstream cc-haha updates.

Custom changes should be isolated behind narrow compatibility boundaries.

Success criterion:

An upstream change should normally require changes in a small compatibility surface, not widespread WorkbenchOS changes.

---

## D-003 — Workbench Task Is Not cc-haha Session

Status: ACCEPTED  
Phase: M0-01 / M0-02

Decision:

WorkbenchOS Task and Run identities are independent from cc-haha Session and CLI Task identities.

Relationship:

```text
Project 1 → N Tasks
Task    1 → N Runs
Run     0..1 → native runtime/session reference
```

A failed or retried Run does not create a new Task.

A native session reference is opaque runtime evidence, not Workbench identity.

---

## D-004 — WorkbenchOS Owns Control-Plane State

Status: ACCEPTED  
Phase: M0-01

WorkbenchOS owns:

- Task identity
- Run identity
- lifecycle
- idempotency
- business approval state
- recovery checkpoints
- result/evidence manifest
- audit events

cc-haha remains authoritative for its native runtime state.

WorkbenchOS must not duplicate cc-haha authority without an explicit recovery reason.

---

## D-005 — M1 Core Lives Inside the Existing Server as an Isolated Module

Status: ACCEPTED FOR M1  
Phase: M0-01

Decision:

Initial WorkbenchOS core location:

```text
src/server/workbenchos/
```

Do not create a separate sidecar in M1.

This decision may be revisited after real runtime integration evidence exists.

---

## D-006 — ChatGPT-Specific Browser Logic Belongs in Electron Main

Status: ACCEPTED  
Phase: M0-01

Decision:

Future `ChatGPTWebAdapter` belongs on the Electron-main/browser side.

WorkbenchOS core must receive normalized events and commands.

Core must not depend on:

- DOM nodes
- selectors
- WebContentsView
- arbitrary JavaScript
- CDP handles
- browser cookie/session objects

---

## D-007 — Use Narrow Versioned Ports

Status: ACCEPTED  
Phase: M0-01 / M0-02

WorkbenchOS core should interact through versioned ports.

Initial port concepts:

- AgentPort
- BrowserAutomationPort
- JournalPort
- future Workspace/Permission boundaries where needed

Vendor/runtime-specific details remain behind adapters.

---

## D-008 — M1 Uses a Minimal Versioned Contract

Status: ACCEPTED  
Phase: M0-02

Decision:

Freeze only the minimum contract needed for:

```text
one conversation
→ one Task
→ one Run
→ one execution agent
→ one normalized Result
→ one review handoff
```

V0.1 freezes responsibilities and semantics, not every field permanently.

Future multi-agent/workflow features are deferred.

---

## D-009 — Task and Run Are Separate State Machines

Status: ACCEPTED  
Phase: M0-02

Decision:

Task and Run lifecycles are separately authoritative Workbench projections.

Important invariant:

```text
task.created
→ CREATED

task.ready
→ READY
```

These semantics must not be collapsed.

A terminal Run does not automatically complete the Task.

A Task moves through explicit review state.

Retries always create a new Run.

---

## D-010 — Idempotency Is a Hard M1 Requirement

Status: ACCEPTED  
Phase: M0-02

Decision:

All external side-effect paths must be idempotent or fail closed when status is uncertain.

Core principle:

> Recovery prefers avoiding duplicate side effects over silently re-running work.

Examples:

- duplicate Task observation returns the existing Task
- duplicate native submission uses the same submission key
- duplicate Result with same hash returns previous outcome
- conflicting same-key payload fails closed
- browser delivery must not be blindly replayed after uncertain crash state

---

## D-011 — Use SQLite as M1 Workbench Persistence

Status: ACCEPTED  
Phase: M0-02

Decision:

Use a dedicated WorkbenchOS SQLite database for M1.

Authoritative pattern:

```text
append-only Workbench events
+
current Task/Run/Result projections
+
idempotency records
+
recovery checks
```

Do not reuse cc-haha native SQLite/JSONL stores as Workbench authority.

Do not build a generalized event-sourcing platform.

---

## D-012 — Side Effects Must Be Outside SQLite Transactions

Status: ACCEPTED  
Phase: M0-03

Required ordering:

```text
persist side-effect intent
→ commit
→ execute AgentPort operation
→ persist receipt/reconciliation
```

Never hold a SQLite transaction while invoking agent/runtime/browser side effects.

---

## D-013 — First Coding Slice Is Isolated Core Only

Status: ACCEPTED  
Phase: M0-03

M1-001 scope:

- contracts
- Task/Run reducers
- idempotency primitives
- JournalPort
- SQLite journal/current projections
- thin WorkbenchCore
- FakeAgentPort
- deterministic tests
- narrow persistence quality-gate routing if revalidated

Excluded:

- real CcHahaRuntimeAdapter
- server API registration
- WebSocket integration
- Electron IPC
- ChatGPT Web adapter
- browser/DOM automation
- multi-agent routing
- scheduling
- automatic commit/push

---

## D-014 — Production Runtime Files Stay Untouched in M1-001

Status: ACCEPTED  
Phase: M0-03

M1-001 must not modify:

- `src/server/index.ts`
- `src/server/router.ts`
- `src/server/ws/handler.ts`
- `src/server/ws/events.ts`
- `src/server/services/conversationService.ts`
- `src/server/services/sessionService.ts`
- `src/server/services/repositoryLaunchService.ts`
- `desktop/**`

Potential existing-file modifications are limited to revalidated quality-gate routing files.

---

## D-015 — Toolchain Validation Is a Hard Gate

Status: ACCEPTED  
Phase: M0-03 Review

Before M1-001 implementation:

```text
bun --version
node --version
git status -sb
git rev-parse --short HEAD
git rev-list --left-right --count main...upstream/main
```

If Bun is unavailable:

STOP.

Do not install it automatically.

No M1-001 implementation can be accepted without executing the relevant Bun tests.

---

## D-016 — Canonical Payload Hashing Must Be Deterministic

Status: ACCEPTED  
Phase: M0-03 Review

Idempotency `payload_hash` must use a defined canonical JSON serialization rule.

Requirements:

- semantic equality produces the same bytes/hash
- object key ordering must not produce false conflicts
- unsupported values are rejected
- a stable cryptographic hash such as SHA-256 is used
- extensions are handled consistently

Do not treat incidental JavaScript insertion order as the protocol specification.

---

## D-017 — Approval and Native Tool Permission Are Separate

Status: ACCEPTED  
Phase: M0-02

Workbench business approval and cc-haha/execution-agent tool permission are distinct layers.

Workbench approval must never imply:

- `bypassPermissions`
- credential access
- commit/push permission
- privileged commands

Protected actions require explicit, scoped authorization.

---

## D-018 — Report-to-Artifact Is the Default Workflow

Status: ACCEPTED  
Phase: M0 closeout

Important Audit, Design, Validation, and Review outputs must be saved as durable Markdown artifacts.

Workflow:

```text
Execution Agent
→ Report Artifact
→ ChatGPT Review
→ Review Artifact
→ Decision Log
→ CURRENT_STATUS
```

Important project knowledge must not exist only in chat history.

Execution agents should not modify `DECISION_LOG.md` or `CURRENT_STATUS.md` unless explicitly authorized.

---

## D-019 — CURRENT_STATUS and DECISION_LOG Are Cache-First Entry Points

Status: ACCEPTED  
Phase: M0 closeout

Default context-loading order:

```text
CURRENT_STATUS
→ DECISION_LOG
→ latest relevant Review
→ underlying Audit/Design/Validation artifact
→ targeted source files
→ broader repository investigation only if required
```

This is intended to reduce repeated repository scans and repeated architectural reasoning.

Dynamic facts must still be reverified before important execution:

- branch
- HEAD
- working tree
- upstream drift
- toolchain availability
- dependency/runtime versions
- test results

---

# D-020 — Use the Existing cc-haha Application-State Root for the Workbench Journal

Status: ACCEPTED  
Date: 2026-10-03  
Scope: Q-6 — production WorkbenchOS database root and path

Decision:

- Resolve the production application-state root with the existing `getClaudeConfigHomeDir()` resolver. It uses `CLAUDE_CONFIG_DIR` when configured and otherwise `<home>/.claude`; the Electron sidecar already receives this setting through the existing environment channel.
- Store the dedicated WorkbenchOS journal at `<root>/cc-haha/db/workbenchos-v1.sqlite`.
- Construct and open the journal only in the server process, passing its path explicitly to `SqliteJournal`. Use the existing `prepareManagedDatabasePath()` managed-layout and path-safety checks.
- Keep the WorkbenchOS journal separate from each existing local-index database and from cc-haha native session/transcript state. Do not use Electron `app.getPath('userData')`, a repository-relative path, or a new root resolver for this journal.
- If the configured root or managed path cannot be used safely, fail closed; do not fall back to a temporary, in-memory, per-process, or alternate database.

Rationale:

The existing server resolver and Electron-to-server environment handoff already define one persistent, relocatable application-state root. Four production SQLite databases use the managed `<root>/cc-haha/db/` layout. The WorkbenchOS journal uses a distinct filename in that layout, preserving a separate database and journal authority while reusing existing path validation. The filename and layout follow the evidence reviewed in `M5-PRE-002` and `M5-PRE-003`.

Consequences:

- Q-6 is resolved. This decision does not itself prove D-WIRE runtime integration, packaged-sidecar behavior, AgentPort production readiness, or the L0-001 Production Gate.
- The provisional M0-03 example `<root>/workbenchos/workbenchos.sqlite3` is superseded for production by this decision because it conflicts with the repository's managed database layout and naming convention.
- No frozen port, state-machine, recovery, idempotency, or approval contract changes.
- Backup/restore policy for the WorkbenchOS journal and cross-process database locking remain separate open implementation concerns; this decision does not authorize either mechanism.

Evidence:

- `docs/tasks/reports/M5-PRE-002_STATE_OWNERSHIP_DECISION_2026-10-03.md`
- `docs/tasks/reports/M5-PRE-003_NAMING_COMPOSITION_DECISION_2026-10-03.md`
- `src/utils/envUtils.ts` (`getClaudeConfigHomeDir`, `getCcHahaDir`)
- `src/server/services/localIndex/managedDatabasePath.ts` (`prepareManagedDatabasePath`)
- `desktop/electron/services/sidecarManager.ts` (`CLAUDE_CONFIG_DIR` handoff)

---

# Deferred Decisions

Not yet frozen:

- CcHahaRuntimeAdapter implementation
- durable cc-haha native submission lookup
- BrowserAutomationPort implementation details
- ChatGPT DOM selectors and completion detection
- result delivery reconciliation in real ChatGPT Web
- production corruption-repair UX
- multi-agent routing
- scheduling
- remote/distributed execution
- long-term knowledge/context engine
- generalized workflow/policy DSL

These require later evidence and review.
