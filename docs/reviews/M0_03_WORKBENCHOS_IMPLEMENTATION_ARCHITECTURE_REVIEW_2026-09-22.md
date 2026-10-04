# M0-03 — WorkbenchOS Implementation Architecture Review

Project: WorkbenchOS  
Review ID: M0-03-R1  
Review Type: First Coding Slice Implementation Architecture Review  
Review Date: 2026-09-22  

Reviewed Artifact:
- `M0-03 — WorkbenchOS First Coding Slice Implementation Architecture Plan` (Codex)

## Review Decision

**ACCEPT WITH CONDITIONS**

The implementation architecture is approved as the basis for the first WorkbenchOS coding slice.

The plan correctly preserves the core architectural objective:

```text
WorkbenchOS Core
→ narrow ports
→ adapters
→ cc-haha runtime
```

and keeps the first slice isolated from real cc-haha runtime, WebSocket, Electron, browser, and ChatGPT integration.

Implementation may proceed only after the conditions in this review are satisfied.

---

# 1. Accepted Architecture

The following decisions are accepted.

## 1.1 Module location

Use:

```text
src/server/workbenchos/
```

for the first isolated server-owned core.

Do not create:

- a separate package
- a sidecar
- production API registration
- runtime composition
- Electron integration

in the first slice.

## 1.2 First implementation scope

Approved scope:

```text
contracts
+
Task / Run reducers
+
idempotency primitives
+
JournalPort
+
SQLite journal and current projections
+
thin WorkbenchCore
+
FakeAgentPort
+
deterministic tests
```

## 1.3 Runtime isolation

The first slice must not modify or import:

- `src/server/ws/handler.ts`
- `src/server/ws/events.ts`
- `src/server/services/conversationService.ts`
- `src/server/services/sessionService.ts`
- `src/server/services/repositoryLaunchService.ts`
- `src/server/index.ts`
- `src/server/router.ts`
- `desktop/**`

This is a hard M1 boundary.

## 1.4 Persistence direction

SQLite is approved for M1.

The WorkbenchOS SQLite database is an independent Workbench authority and must not reuse cc-haha native databases.

Database path remains constructor/configuration injected in the first slice.

No production application-data path is frozen yet.

## 1.5 Quality gate routing

The Codex finding that the new persistence path would not currently select the repository persistence-upgrade lane is accepted.

The first coding slice may therefore modify only these existing quality-policy files, if validation confirms the routing gap still exists at implementation time:

- `scripts/pr/change-policy.ts`
- `scripts/pr/change-policy.test.ts`
- `scripts/quality-gate/persistence-upgrade.ts`

These changes are quality-routing changes only, not runtime integration.

---

# 2. Required Conditions Before Coding

## Condition A — Toolchain preflight must pass

M0-01 reported that Bun was not available in the executing environment.

The first coding slice depends on:

- Bun test runner
- `bun:sqlite`
- repository quality gates

Therefore implementation must begin with a toolchain preflight.

Required evidence:

```text
bun --version
node --version
git status -sb
git rev-parse --short HEAD
git rev-list --left-right --count main...upstream/main
```

If Bun is unavailable:

**STOP.**

Do not install Bun automatically.

Report the missing toolchain and wait for explicit user authorization / setup.

No implementation result may be accepted without actually running the relevant Bun tests.

## Condition B — Documentation and implementation must not be mixed accidentally

At review time, the architecture artifacts are still untracked.

Before implementation, verify the repository state and distinguish:

```text
authorized architecture documentation
vs
new implementation changes
```

Prefer a documentation-only commit before the first coding slice, after explicit user authorization.

Do not stage or commit anything implicitly.

## Condition C — Preserve `CREATED → READY` semantics

The M0-03 test matrix uses `CREATED/READY` as the expected outcome of task creation.

M0-02 froze these as distinct semantic states:

```text
task.created
→ CREATED

task.ready
→ READY
```

Implementation may emit both events in one command/transaction if validation is immediately successful, but it must not collapse them into one state transition or remove either event semantic.

Tests must prove the event ordering explicitly.

## Condition D — Canonical payload hashing must be deterministic

Idempotency depends on `payload_hash`.

Before implementation, choose and test one deterministic canonical serialization rule.

Minimum requirement:

- same semantic Workbench payload produces the same bytes/hash
- object key order does not create false conflicts
- unsupported/non-JSON values are rejected
- hashing uses a stable algorithm such as SHA-256
- extensions participate consistently in hashing

Do not rely on incidental JavaScript object insertion order as the protocol definition.

## Condition E — Keep Event Sourcing minimal

Approved persistence pattern:

```text
append-only domain events
+
current Task/Run/Result projections
+
idempotency records
+
recovery checks
```

Do not add:

- generic aggregate framework
- event bus
- snapshot framework
- compaction system
- generalized replay platform
- cross-process replication

Projection reconstruction should be narrow and specific to M1 Task/Run state.

## Condition F — Side effects remain outside DB transactions

The approved ordering is:

```text
persist side-effect intent
→ commit
→ call AgentPort
→ persist receipt/reconciliation
```

Never hold a SQLite transaction open across:

- `submitTask()`
- `lookupSubmission()`
- `getStatus()`
- `collectResult()`
- `cancel()`

This is a hard correctness constraint.

---

# 3. File Layout Decision

Approved starting layout:

```text
src/server/workbenchos/
  contracts.ts

  ports/
    agentPort.ts
    journalPort.ts

  core/
    taskReducer.ts
    runReducer.ts
    idempotency.ts
    workbenchCore.ts

  persistence/
    schema.ts
    sqliteJournal.ts

  testing/
    fakeAgentPort.ts

  contracts.test.ts
  dependencyBoundary.test.ts

  core/
    stateReducers.test.ts
    workbenchCore.contract.test.ts

  persistence/
    sqliteJournal.test.ts

  testing/
    fakeAgentPort.test.ts
```

### Notes

- No barrel `index.ts` is required.
- Do not create real adapters yet.
- `contracts.ts` may remain consolidated for V0.1.
- Split it only if implementation evidence shows it is becoming difficult to maintain.
- No new parser dependency should be introduced solely for `dependencyBoundary.test.ts`; prefer existing repository tooling or a narrow deterministic source scan.

---

# 4. Dependency Rules

## Allowed

```text
contracts
↑
reducers / ports
↑
WorkbenchCore
↑
future composition

JournalPort ← SqliteJournal
AgentPort   ← FakeAgentPort
```

## Forbidden for the first slice

WorkbenchOS production code must not directly import:

```text
src/server/ws/**
src/server/services/conversationService.ts
src/server/services/sessionService.ts
src/server/services/repositoryLaunchService.ts
src/server/services/localIndex/**
desktop/**
electron
WebContentsView
```

The architecture test must fail if these dependencies appear.

---

# 5. Persistence Review

The proposed minimal persistence responsibilities are accepted:

- events
- task projection
- run projection
- immutable results
- idempotency records
- schema metadata

The following are deferred:

- approvals projection table
- browser delivery outbox
- artifact blob database
- workflow state
- agent team state
- generalized snapshots

SQLite configuration direction is accepted:

```text
foreign_keys = ON
journal_mode = WAL
synchronous = FULL
bounded busy_timeout
single Workbench writer
explicit open / close
```

### Recovery behavior

Approved:

```text
open
→ validate schema
→ integrity checks
→ validate event/projection checkpoint
→ narrowly rebuild missing/behind projections
→ fail closed on impossible/conflicting authority
→ recover non-terminal Runs
```

Database corruption must never silently create a fresh empty Workbench authority.

---

# 6. State Machine Review

Pure reducers are approved.

Reducers must:

- be deterministic
- perform no IO
- read no clock
- generate no IDs
- call no ports
- reject invalid transitions with typed results
- use exhaustive transition handling

WorkbenchCore owns:

- command preconditions
- clock/ID generation
- journal transaction orchestration
- side-effect ordering
- recovery dispatch

Run retries must always create a new `run_id`.

Terminal Runs must never transition back to active states.

---

# 7. FakeAgentPort Review

Approved.

FakeAgentPort is not just a mock; it is the first executable proof of the AgentPort contract.

It must deterministically support at least:

- accepted
- running
- succeeded
- failed
- cancelled
- timed_out
- unknown/recovery ambiguity

It must also simulate the critical crash window:

```text
native side effect happened
→ Workbench did not persist receipt
→ lookup by original idempotency key
→ same native receipt returned
→ execution count remains one
```

No real subprocess, timeout, random value, network, provider, or browser may be used.

---

# 8. Test Contract

The first coding slice is not complete because the files compile.

Required evidence includes:

1. Task validation
2. Task `CREATED → READY` event ordering
3. Run creation
4. legal transitions
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

Every relevant test should preserve:

```text
Input
→ Processing
→ Artifact
→ State
→ Validation
```

---

# 9. Upstream Compatibility Decision

The first implementation slice is considered upstream-friendly only if:

- production cc-haha runtime files remain untouched
- Workbench code is isolated under `src/server/workbenchos/`
- existing modifications are limited to justified quality-gate routing files
- Workbench core imports no high-churn runtime internals
- production runtime registration remains deferred

This design preserves the future seam:

```text
WorkbenchOS Core
→ AgentPort
→ future CcHahaRuntimeAdapter
→ generic cc-haha runtime facade
```

The real runtime adapter remains blocked until durable submission lookup/reconciliation can be provided.

---

# 10. Implementation Sequence

Approved implementation order:

```text
0. Git + Bun preflight

1. Contracts / semantic validation
2. Port interfaces
3. Task / Run reducers
4. SQLite schema + journal
5. Idempotency primitives
6. Thin WorkbenchCore
7. FakeAgentPort
8. Integrated deterministic tests
9. Persistence quality-routing changes
10. Focused validation
11. Full scope/diff review
12. Commit decision
```

Do not begin real browser/runtime integration after this slice automatically.

A separate review is required first.

---

# 11. Validation Commands

At minimum, after implementation:

```text
bun test ./src/server/workbenchos/contracts.test.ts
bun test ./src/server/workbenchos/core/stateReducers.test.ts
bun test ./src/server/workbenchos/persistence/sqliteJournal.test.ts
bun test ./src/server/workbenchos/core/workbenchCore.contract.test.ts
bun test ./src/server/workbenchos/dependencyBoundary.test.ts
```

Then:

```text
bun run check:impact
bun run check:server
bun run check:persistence-upgrade
git diff --check
```

If the implementation is proposed as PR-ready, run:

```text
bun run verify
```

Never report a test as passed if it could not be executed.

---

# 12. Scope Boundary for M1-001

The first coding task may create WorkbenchOS core files and the narrowly justified quality-gate changes.

It must not:

- register production routes
- open a Workbench database at server startup
- use a production application-data path
- touch WebSocket runtime
- spawn real agents
- modify browser/Electron code
- implement ChatGPT selectors
- create CcHahaRuntimeAdapter
- commit/push automatically
- install Bun/dependencies without explicit authorization

---

# 13. Review Outcome

## ACCEPT

- `src/server/workbenchos/` isolated core
- minimal contracts
- pure reducers
- SQLite journal/current projections
- deterministic idempotency
- thin application service
- FakeAgentPort
- dependency-boundary contract test
- narrow persistence quality-routing update

## MODIFY / CLARIFY

- explicit toolchain gate before implementation
- preserve separate `task.created` / `task.ready` semantics
- define deterministic canonical hashing
- keep projection rebuild narrow
- no parser dependency only for architecture tests
- documentation state must be handled separately from coding state

## DEFER

- real CcHahaRuntimeAdapter
- BrowserAutomationPort implementation
- ChatGPTWebAdapter
- server API registration
- Electron IPC
- production DB path
- approvals projection table
- delivery outbox
- multi-agent routing
- scheduling
- automatic Git actions

---

# 14. Decision

**M0 architecture planning is complete enough to begin the first isolated coding slice.**

Next implementation task:

**M1-001 — WorkbenchOS Isolated Core Foundation**

However, before M1-001 modifies code:

1. save this review artifact,
2. verify Git state,
3. preferably create a documentation-only baseline commit with explicit user authorization,
4. verify Bun is available.

No implementation commit or push is authorized by this review.
