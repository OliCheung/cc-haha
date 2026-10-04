# WorkbenchOS — Project Rules

This document defines WorkbenchOS-specific conventions for how project knowledge is produced,
stored, reviewed, and decided.

Scope: this is **local governance for the WorkbenchOS control-plane work built on top of
cc-haha**. It **extends** the repository-root [`AGENTS.md`](AGENTS.md) and the nested
[`docs/AGENTS.md`](docs/AGENTS.md); it does **not** replace or override them. Where this document
and an upstream cc-haha rule overlap, the more specific rule that is closer to the code in
question applies (see root `AGENTS.md`). Nothing here changes how cc-haha itself is built,
tested, released, or documented.

Canonical decisions live in [`docs/decisions/DECISION_LOG.md`](docs/decisions/DECISION_LOG.md);
current project state lives in [`state/CURRENT_STATUS.md`](state/CURRENT_STATUS.md). Those two
files are the entry points; this document describes the workflow around them.

---

## 1. Project Identity

- WorkbenchOS is a local-first, artifact-first, agent-neutral AI development control plane built
  on top of **cc-haha** as its first runtime/execution foundation.
- cc-haha remains the runtime/execution foundation, not the WorkbenchOS source of truth.
  WorkbenchOS owns its own `project_id` / `task_id` / `run_id` identity, Task/Run lifecycle,
  idempotency, business approval state, recovery checkpoints, and audit events
  (`DECISION_LOG.md` D-001, D-003, D-004).
- This repository is an **upstream-friendly fork** of cc-haha (`DECISION_LOG.md` D-002).
  WorkbenchOS-specific changes must stay behind narrow compatibility boundaries so upstream
  updates remain cheap to absorb.
- WorkbenchOS is a distinct control-plane architecture; it is not a rename of cc-haha concepts.
  In particular, a Workbench Task is **not** a cc-haha Session or CLI Task (`DECISION_LOG.md` D-003).

## 2. Artifact Policy

Important project knowledge must exist as **durable artifacts**. Chat history is not the source
of truth (`DECISION_LOG.md` D-018).

Recognized artifact classes:

| Artifact | Purpose |
|---|---|
| Audit report | Baseline and source investigations (evidence) |
| Design document | Architecture / contract / implementation proposals |
| Review report | Review of an audit or design; records the accept/modify/reject outcome |
| Validation report | Preflight, completeness, and alignment validation |
| Decision log | Concise, reusable accepted decisions |
| Current status | Cache-first project state entry point |

Workflow:

```text
Execution Agent
→ Report Artifact
→ Review
→ Decision
→ CURRENT_STATUS
```

Artifacts are evidence; the Decision Log and Current Status are the curated sources that should be
read before re-deriving context. Dynamic facts (branch, HEAD, working tree, upstream drift,
toolchain, test results) must still be re-verified before important operations
(`DECISION_LOG.md` D-019).

## 3. Directory Ownership

```text
docs/
├── audits/       # baseline & source audits (evidence)
├── design/       # design / architecture / contract artifacts
├── reviews/      # reviews of audits and designs
├── decisions/    # DECISION_LOG.md — accepted decisions (canonical)
└── validation/   # preflight, completeness, and alignment reports

state/
├── CURRENT_STATUS.md   # cache-first status entry point
└── (future state documents)
```

These five `docs/` subtrees and the `state/` directory are **WorkbenchOS-local governance
artifacts**. They are intentionally segregated from the published cc-haha documentation site
sections (`start/`, `desktop/`, `im/`, `cli/`, `internals/`, and their `docs/en/` mirrors).

`docs/AGENTS.md` governs the **published documentation site content**; those rules remain fully in
force for the site sections. WorkbenchOS process artifacts above are not published site pages and
are not part of the doc-site section structure or manifest. Do not place published site content
into the governance subtrees, and do not place governance artifacts into the site sections.

## 4. Agent Workflow

```text
Task Package → Execution Agent → Artifact → Review → Decision
```

- A **task package** is an input. It declares the goal, allowed changes, forbidden changes,
  implementation steps, validation expectations, and the required final artifact.
- An **execution agent** performs the scoped change, produces the artifact, and reports changed
  files, commands run, and results.
- Execution agents must **not** modify final decision files — `docs/decisions/DECISION_LOG.md` and
  `state/CURRENT_STATUS.md` — unless a task explicitly authorizes it (`DECISION_LOG.md` D-018).
- **Reviews** are performed against artifacts, not chat history. A review produces a decision
  (accept / accept with revisions / reject) and, when durable, a new decision record.
- Work stays inside the boundary declared by the task package; anything beyond it requires a new
  task or explicit authorization.

## 5. Git Safety

- **No** commit, push, merge, rebase, reset, or clean without explicit user authorization
  (root `AGENTS.md`; `DECISION_LOG.md` D-018).
- **No** destructive Git operations.
- Verify repository state — repository path, branch, HEAD, origin/upstream, working tree, and
  ahead/behind — before any important operation (`DECISION_LOG.md` D-015, D-019).
- Do not modify Git configuration. If a read-only command is blocked by an ownership check, use a
  per-command, non-persistent override (for example
  `git -c safe.directory=<repo> ...`) rather than changing config.
- Keep documentation changes and implementation changes separate; do not stage or commit
  implicitly.

## 6. Upstream Relationship

- cc-haha upstream rules remain important and in force. WorkbenchOS rules **extend** upstream
  behavior; they do not replace it.
- Do not embed WorkbenchOS-specific policy or naming into high-churn cc-haha runtime internals
  (`DECISION_LOG.md` D-002). Prefer narrow, versioned ports and small generic upstream hooks.
- For the first coding slice, WorkbenchOS code stays isolated under `src/server/workbenchos/`, and
  production runtime files remain untouched unless a task explicitly authorizes otherwise
  (`DECISION_LOG.md` D-005, D-013, D-014).
- When a needed cc-haha seam is missing, prefer a tiny generic hook over copying or forking
  upstream implementation.

---

## Related Documents

- [`AGENTS.md`](AGENTS.md) — repository-wide agent routing and implementation rules
- [`docs/AGENTS.md`](docs/AGENTS.md) — published documentation-site rules
- [`docs/decisions/DECISION_LOG.md`](docs/decisions/DECISION_LOG.md) — accepted decisions
- [`state/CURRENT_STATUS.md`](state/CURRENT_STATUS.md) — current project state and next action
