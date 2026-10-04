# M0-03 — WorkbenchOS First Coding Slice Implementation Architecture Plan

结论：第一个 coding slice 应作为完全隔离、尚未注册到生产生命周期的 `src/server/workbenchos/` 模块实现。它包含最小合同、纯 Task/Run reducers、SQLite journal/current projections、幂等 primitives、薄 application service、FakeAgentPort 和确定性测试；不修改 server router/index、WebSocket、cc-haha runtime 或 Electron/browser。

## 1. Execution Identity

- Agent：Codex
- Model family：GPT-5-based Codex
- Task-requested route：Sol
- Exact deployed model/SKU：`UNKNOWN`，当前环境未暴露可验证标识
- Reasoning strength：按任务包以 High 执行；精确 telemetry 为 `UNKNOWN`
- Execution mode：Analysis only

## 2. Git Preflight

| 项目实际结果                 |                                             |
| ---------------------- | ------------------------------------------- |
| Repository             | `M:\vibecoding\Projects\WorkbenchOS`        |
| Branch                 | `main`                                      |
| HEAD                   | `b8c7a11507c8da63f5c6745f7c27db99d6a313c0`  |
| origin                 | `https://github.com/OliCheung/cc-haha.git`  |
| upstream               | `https://github.com/NanmiCoder/cc-haha.git` |
| `main...origin/main`   | ahead `0`, behind `0`                       |
| `main...upstream/main` | ahead `0`, behind `0`                       |
| Tracked diff           | empty                                       |
| Staged diff            | empty                                       |

当前仅有任务明确要求读取的三份未跟踪 M0 文档：

```
docs/audits/M0_01_CODEX_CC_HAHA_BASELINE_AUDIT_2026-09-21.md
docs/reviews/M0_01_WORKBENCHOS_ARCHITECTURE_REVIEW_2026-09-21.md
docs/reviews/M0_02_WORKBENCHOS_CONTRACT_ARCHITECTURE_REVIEW_2026-09-22.md
```

未发现无关或无法解释的改动。

## 3. Architecture Constraints

从 M0-01/M0-02 继承的硬约束：

1. WorkbenchOS 独立拥有 Task、Run、Approval、Recovery、Idempotency 和 Audit 状态。
2. cc-haha Session、CLI Task、WebSocket state 都不能成为 Workbench Task/Run 权威。
3. 首个实现位于 server 内部隔离模块，不创建 package 或 sidecar。
4. 首个 slice 不接真实 browser 或 cc-haha runtime。
5. SQLite 只实现：
   - append-only events
   - current projections
   - idempotency records
   - recovery checks
6. 不构建通用 event-sourcing framework、event bus、workflow engine 或 policy engine。
7. V0.1 冻结职责和边界，不要求永久冻结每个字段。
8. Core 不得 import Electron、WebSocket handler、raw stream-json、cc-haha persistence schema 或 runtime singleton。
9. AgentPort side effect 必须发生在数据库事务之外，且必须先持久化 intent。
10. 首个 slice 不提供 HTTP/API/WebSocket 入口，不产生真实用户状态。

## 4. Recommended Module Layout

### 4.1 选项比较

| 选项评价决策                    |                                                         |        |
| ------------------------- | ------------------------------------------------------- | ------ |
| `src/server/workbenchos/` | 符合 server-owned 决策；沿用 Bun/TypeScript/test tooling；可完全隔离 | **推荐** |
| 单独 package                | 需要 workspace、build、exports 和版本管理；首切片没有收益                | 拒绝     |
| sidecar process           | 引入进程生命周期、认证、IPC、升级和崩溃恢复                                 | 拒绝     |
| 放入 `src/server/services/` | 容易与现有 session/runtime singleton 混合                      | 拒绝     |
| 放入 WebSocket/API 目录       | 会错误地把 transport 变成核心边界                                  | 拒绝     |

### 4.2 推荐目录树

```
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

设计约束：

- 不创建 `index.ts` barrel。首切片没有生产消费者，过早 barrel 容易形成未经评审的公共 surface。
- `contracts.ts` 初期集中保存 V0.1 类型与验证器；只有明显失控后才拆成一类型一文件。
- 不创建 `adapters/ccHahaRuntimeAdapter.ts`。
- 不创建 BrowserAutomationPort 实现、ChatGPT adapter 或 Electron 文件。
- 不在 import 时打开数据库或创建 singleton。

### 4.3 Test discovery

现有 server test runner 会递归发现 `src/**` 下的 `*.test.*`，因此这些测试无需 router/index 注册即可运行：

- [run-server-tests.ts](file:///M:/vibecoding/Projects/WorkbenchOS/scripts/pr/run-server-tests.ts:15)
- [change-policy.ts](file:///M:/vibecoding/Projects/WorkbenchOS/scripts/pr/change-policy.ts:234)

## 5. Dependency Boundary

### 5.1 允许的方向

```
contracts
  ↑       ↑
reducers  ports
    \     /
     \   /
   workbenchCore
       ↑
   composition

journalPort ← sqliteJournal → bun:sqlite
agentPort   ← fakeAgentPort
```

具体规则：

- `contracts.ts`
  - 不依赖其他 WorkbenchOS 模块。
- `taskReducer.ts` / `runReducer.ts`
  - 只依赖 contracts。
- `agentPort.ts` / `journalPort.ts`
  - 只依赖 contracts 和必要的 projection value types。
- `workbenchCore.ts`
  - 依赖 contracts、reducers、ports、idempotency。
- `sqliteJournal.ts`
  - 依赖 contracts、projection types、JournalPort 和 `bun:sqlite`。
- `fakeAgentPort.ts`
  - 依赖 AgentPort 和 contracts。
- Tests
  - 直接 import 被测文件。
- 未来 `CcHahaRuntimeAdapter`
  - 实现 AgentPort，并依赖新抽取的 generic runtime facade。
  - Core 永远不能反向 import adapter。

### 5.2 禁止的依赖

`src/server/workbenchos/**` 首切片不得 import：

```
src/server/index.ts
src/server/router.ts
src/server/ws/**
src/server/services/conversationService.ts
src/server/services/sessionService.ts
src/server/services/repositoryLaunchService.ts
src/server/services/localIndex/**
desktop/**
electron
WebContentsView
```

还应增加 `dependencyBoundary.test.ts`，扫描 WorkbenchOS production imports 并拒绝这些前缀。当前仓库没有现成的分层禁止规则，因此需要一个窄、确定性的 architecture contract test。

### 5.3 Future extraction

未来若独立成 package，只需移动：

```
contracts
core
ports
journal implementation
```

因为这些模块不依赖 server singleton、router、Electron 或 vendor-specific types。生产 composition root 留在 cc-haha server。

## 6. First Coding Slice

### 6.1 包含范围

```
Task/Result/Event V0.1 contracts
+
Task/Run pure reducers
+
idempotency key/hash primitives
+
JournalPort
+
SQLite journal/current projections
+
thin WorkbenchCore application service
+
FakeAgentPort
+
deterministic tests
+
persistence-check routing
```

### 6.2 不包含

- server API
- router/index registration
- WebSocket messages
- real cc-haha adapter
- browser port implementation
- Electron IPC
- ChatGPT DOM
- approval engine
- artifact blob store
- scheduling
- multi-agent
- automatic retry across Runs
- commit/push/worktree actions

### 6.3 为什么需要薄 `WorkbenchCore`

只实现 reducers、journal 和 FakeAgentPort 会分别证明组件正确，但不能证明：

```
Task accepted once
→ Run created once
→ submission intent persisted
→ FakeAgentPort invoked once
→ Result recorded once
→ restart does not duplicate submission
```

因此需要一个很薄的 application service，负责：

- command orchestration
- transaction boundary
- side-effect ordering
- recovery dispatch
- clock/ID injection

它不包含 transport、UI、runtime 或 browser 逻辑。

建议方法：

```
createTask()
markTaskReady()
startRun()
reconcileRun()
cancelRun()
recoverPendingRuns()
```

## 7. File Plan

### 7.1 新文件

| PathResponsibilityOwnerDependenciesTest |                                                           |               |                                    |                        |
| --------------------------------------- | --------------------------------------------------------- | ------------- | ---------------------------------- | ---------------------- |
| `workbenchos/contracts.ts`              | V0.1 envelopes、states、errors、semantic validators          | Core          | 无 Workbench imports                | `contracts.test.ts`    |
| `ports/agentPort.ts`                    | AgentPort interface、normalized receipts/status/errors     | Core boundary | contracts                          | Fake/contract tests    |
| `ports/journalPort.ts`                  | Core 所需最小 journal API                                     | Core boundary | contracts/projections              | SQLite contract tests  |
| `core/taskReducer.ts`                   | 纯 Task transition reducer                                 | Core          | contracts                          | reducer tests          |
| `core/runReducer.ts`                    | 纯 Run transition reducer                                  | Core          | contracts                          | reducer tests          |
| `core/idempotency.ts`                   | namespaced keys、canonical payload hashing、conflict result | Core          | contracts、标准 crypto                | contract/journal tests |
| `core/workbenchCore.ts`                 | command、事务、AgentPort side-effect ordering、recovery        | Core          | reducers、ports、idempotency         | core contract tests    |
| `persistence/schema.ts`                 | schema version 1、DDL/bootstrap、版本检查                       | Persistence   | `bun:sqlite` types if needed       | journal tests          |
| `persistence/sqliteJournal.ts`          | open/close、事务、events、projections、dedupe、recovery queries  | Persistence   | JournalPort、contracts、`bun:sqlite` | journal tests          |
| `testing/fakeAgentPort.ts`              | 可脚本化、确定性的 AgentPort                                       | Test support  | AgentPort、contracts                | fake/contract tests    |
| `contracts.test.ts`                     | envelope/version/semantic validation                      | Test          | contracts                          | focused                |
| `dependencyBoundary.test.ts`            | 禁止 WorkbenchOS core 导入高风险 cc-haha 模块                      | Test          | source import parser/简单静态扫描        | focused                |
| `core/stateReducers.test.ts`            | 合法与非法 Task/Run transitions                                | Test          | reducers                           | focused                |
| `core/workbenchCore.contract.test.ts`   | Task→Run→Fake→Result→restart 全链                           | Test          | Core、SQLite、Fake                   | contract               |
| `persistence/sqliteJournal.test.ts`     | schema、atomicity、dedupe、reopen、recovery                   | Test          | SQLite journal                     | focused                |
| `testing/fakeAgentPort.test.ts`         | script、fault injection、call counts                        | Test          | FakeAgentPort                      | focused                |

### 7.2 必需的 companion quality-policy 修改

仓库当前的 persistence path allowlist 不包含未来的 `src/server/workbenchos/persistence/`。仅依赖 `check:impact` 会漏选 persistence-upgrade lane。

第一 slice 应同时做三个窄修改：

| Existing filePlanned change                   |                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `scripts/pr/change-policy.ts`                 | 将 `src/server/workbenchos/persistence/` 加入 `persistencePrefixes` |
| `scripts/pr/change-policy.test.ts`            | 证明该路径选择 persistence check                                        |
| `scripts/quality-gate/persistence-upgrade.ts` | 加入 WorkbenchOS schema/reopen migration test                      |

这是首切片唯一建议修改的现有文件组。它们不接入生产 runtime，只确保新持久格式不会绕过质量门禁。

### 7.3 必须保持 untouched

```
src/server/index.ts
src/server/router.ts
src/server/server.ts
src/server/ws/handler.ts
src/server/ws/events.ts
src/server/services/conversationService.ts
src/server/services/sessionService.ts
src/server/services/repositoryLaunchService.ts
src/server/services/localIndex/**
desktop/**
```

## 8. Persistence Plan

### 8.1 Database location

首切片：

```
new SqliteJournal({ databasePath })
```

- `databasePath` 必须由调用方显式注入。
- 测试使用独立临时目录。
- 不访问真实 HOME、`~/.claude`、browser profile 或 repository 内文件。
- 不在 module import 时创建数据库。

未来生产位置：

```
<resolved-application-state>/workbenchos/workbenchos.sqlite3
```

该路径必须：

- 位于 WorkbenchOS/cc-haha application-data root
- 不在 Git repository
- 不在 cc-haha native session/transcript 目录
- 不复用 local-index DB
- 由后续 production registration slice 决定具体平台解析方式

### 8.2 Minimal schema

```
schema metadata / PRAGMA user_version

events
  sequence INTEGER PRIMARY KEY AUTOINCREMENT
  event_id UNIQUE
  task_id
  run_id NULLABLE
  event_type
  protocol_version
  producer
  dedupe_key
  payload_hash
  payload_json
  recorded_at
  causation_event_id NULLABLE

tasks
  task_id PRIMARY KEY
  state
  envelope_json
  active_run_id NULLABLE
  latest_result_id NULLABLE
  version
  last_event_sequence
  updated_at

runs
  run_id PRIMARY KEY
  task_id
  attempt
  state
  submission_key
  native_ref NULLABLE
  result_id NULLABLE
  version
  last_event_sequence
  updated_at
  UNIQUE(task_id, attempt)

results
  result_id PRIMARY KEY
  run_id UNIQUE
  payload_hash
  envelope_json
  recorded_at

idempotency
  namespace
  operation_key
  payload_hash
  outcome_ref
  status
  created_at
  completed_at NULLABLE
  PRIMARY KEY(namespace, operation_key)
```

M1 首切片不创建：

- approvals projection table
- browser delivery outbox
- artifact blob table
- workflow/agent-team tables
- generic aggregate registry
- snapshot/compaction framework

### 8.3 SQLite behavior

借鉴现有 `bun:sqlite` 使用范式，但不 import 现有 local-index 模块：

- [localIndex/database.ts](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/localIndex/database.ts:1)
- [localIndex/migrations.ts](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/localIndex/migrations.ts:219)
- [localIndex/database.test.ts](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/localIndex/database.test.ts:359)

建议：

```
journal_mode = WAL
foreign_keys = ON
synchronous = FULL
busy_timeout = bounded value
```

- 一个 Workbench writer。
- 使用显式 `open()`/`close()`。
- 初始化或迁移失败必须关闭连接。
- 不吞掉 database startup/recovery error。
- side effect 永远不在 SQLite transaction 内执行。

### 8.4 Atomic write unit

一次 domain commit 原子包含：

```
expected projection version check
+
idempotency reservation/update
+
one or more ordered events
+
Task/Run/Result current projection update
+
projection checkpoint
```

例如 terminal result：

```
run.result_recorded
+
Run → terminal
+
task.review_ready
+
Task → WAITING_REVIEW
+
Result projection
```

在同一事务提交。

### 8.5 Migration approach

不构建 migration framework。

V1 只实现：

- `schemaVersion = 1`
- 空数据库 `0 → 1`
- current version reopen
- future version fail closed
- migration/bootstrap transaction
- failed migration rollback

未来版本再增加明确的顺序函数：

```
migrateV1ToV2()
```

禁止：

- 自动 drop/recreate
- 对未知新版本降级打开
- 失败后静默建立空库
- 在 production open 时修改真实 native cc-haha DB

### 8.6 Recovery flow

```
open DB
→ validate schema version
→ PRAGMA quick_check / foreign_key_check
→ compare projection checkpoint with event sequence
→ rebuild missing/behind aggregate projection from its events
→ fail closed if projection is ahead or event/hash conflicts
→ load non-terminal Runs
→ WorkbenchCore.recoverPendingRuns()
→ lookup/resubmit only with the original submission key
```

这不是完整 event-sourcing framework：

- 没有 event subscriptions
- 没有 generic aggregate registry
- 没有 snapshot compaction
- 没有 cross-process replication
- 只用 Task/Run 两个已知 reducers 修复 current projections

## 9. State Machine Implementation Plan

### 9.1 Pure reducers

```
reduceTask(current, event): TransitionResult<TaskProjection>
reduceRun(current, event): TransitionResult<RunProjection>
```

Reducers：

- 纯函数
- 不读取数据库
- 不调用 AgentPort
- 不生成 ID
- 不读取当前时间
- 不抛 generic exception 表示预期 invalid transition
- 使用 exhaustive event switch
- 返回 typed `INVALID_TRANSITION`

建议结果：

```
type TransitionResult<T> =
  | { ok: true; next: T }
  | {
      ok: false
      error: {
        code: 'INVALID_TRANSITION'
        aggregate: 'task' | 'run'
        current_state: string
        event_type: string
      }
    }
```

### 9.2 Validation ownership

| LayerResponsibility |                                                                |
| ------------------- | -------------------------------------------------------------- |
| Contracts           | shape、protocol version、path/value semantic validation          |
| WorkbenchCore       | command preconditions、active Run guard、approval/timeout intent |
| Reducers            | 当前 state 是否允许该 event                                           |
| SQLite              | uniqueness、foreign keys、projection version                     |
| AgentPort adapter   | native receipt/status/result normalization                     |

### 9.3 ID/timestamp ownership

注入：

```
Clock.now(): string
IdGenerator.next(): string
```

- WorkbenchCore 生成 `task_id`、`run_id`、`event_id`、`result_id`。
- WorkbenchCore 生成 authoritative `recorded_at`。
- Reducers只消费已记录 metadata。
- Tests 使用 deterministic clock 和 sequential IDs。

### 9.4 Side-effect ordering

`startRun()`：

```
transaction:
  validate Task READY
  create Run
  set Task active_run_id
  append run.created
  append run.submission_requested
  persist submission key
commit

AgentPort.submitTask(original key)

transaction:
  append run.native_bound or recorded recovery evidence
  update Run projection
commit
```

如果 AgentPort 调用超时：

- Run 保持 `SUBMITTED`
- 不用新 key retry
- restart/reconcile 使用 `lookupSubmission(originalKey)`

### 9.5 Optimistic concurrency

每个 projection 带 `version`。

Journal update 使用：

```
WHERE id = ? AND version = expectedVersion
```

更新行数不是 1 时返回 concurrency conflict；Core 重新读取并重新评估 command，不能直接重放旧 projection。

## 10. Fake AgentPort Plan

### 10.1 Responsibilities

Fake 必须实现与真实 AgentPort 相同的 production interface，并模拟：

- accepted
- running
- succeeded
- failed
- cancelled
- timed_out
- unknown/recovery ambiguity

### 10.2 Deterministic control API

测试专用 concrete API：

```
fake.enqueueScenario({
  steps: [
    { status: 'accepted' },
    { status: 'running' },
    { status: 'succeeded', result }
  ]
})

fake.advance(nativeRef)
fake.injectFault(...)
fake.getCalls()
```

规则：

- 不使用 `setTimeout`。
- 不使用真实 clock、random 或 subprocess。
- 状态仅在测试显式 `advance()` 时变化。
- `getStatus()` 只观察，不因 polling 次数推进。
- submission key 映射到唯一 receipt。
- duplicate submit 返回同一 receipt，不增加 side-effect count。
- duplicate cancel 返回原 cancel receipt。
- result 对同一 native ref 不变。

### 10.3 Failure injection

最低需要：

```
submit fails before effect
submit applies effect then loses acknowledgement
lookup unavailable
status unknown
result duplicated
result conflicts
cancel accepted
cancel ignored
cancel applies then acknowledgement lost
```

核心 crash-window 测试重点是：

```
effect happened
→ Workbench did not record receipt
→ lookup by original key
→ no duplicate execution
```

### 10.4 Fake state and restart

- Workbench server restart 测试保留同一个 FakeAgentPort 实例，模拟 native runtime 仍在。
- SQLite journal close/reopen并重新创建 WorkbenchCore。
- 不需要在第一 slice 为 Fake 本身实现磁盘持久化。
- 后续若需要模拟 native runtime restart，可增加 test-only snapshot/restore，不进入 AgentPort V0.1。

## 11. Test Strategy

所有测试必须使用：

- temp database path
- deterministic clock/IDs
- FakeAgentPort
- 无 HOME/CLAUDE_CONFIG_DIR 读写
- 无 browser/provider/network
- 显式 close/cleanup

### 11.1 Contract test matrix

| TestInputProcessingArtifactStateValidation |                                    |                                  |                               |                                |                                  |
| ------------------------------------------ | ---------------------------------- | -------------------------------- | ----------------------------- | ------------------------------ | -------------------------------- |
| 1 Task creation                            | valid TaskEnvelope                 | validate + commit                | task.created event            | CREATED/READY                  | 一个 Task、一个 key                   |
| 2 Run creation                             | READY Task                         | create Run batch                 | run.created/submission intent | Task RUNNING, Run SUBMITTED    | 唯一 active Run                    |
| 3 State transitions                        | legal Task/Run events              | pure reducers                    | next projections              | expected sequence              | 每步 deterministic                 |
| 4 Invalid transition                       | terminal→running 等                 | reducer reject                   | typed error                   | unchanged                      | journal 无新 event                 |
| 5 Duplicate submission                     | same submission key twice          | Fake idempotency                 | same receipt                  | one Run                        | side-effect count=1              |
| 6 Duplicate result                         | same run/result hash twice         | idempotency check                | one Result                    | one terminal state             | second call returns prior result |
| 7 Conflicting result                       | same Run, different hash           | conflict check                   | conflict evidence             | unchanged                      | fail closed                      |
| 8 Restart recovery                         | close DB after submission intent   | reopen + recovery                | original receipt/events       | same Run                       | no new submission                |
| 9 Fake success                             | accepted→running→success           | reconcile                        | ResultEnvelope                | SUCCEEDED/WAITING_REVIEW       | validations/result recorded      |
| 10 Fake failure                            | running→failure                    | normalize + commit               | failed Result                 | FAILED/WAITING_REVIEW          | errors nonempty                  |
| 11 Cancellation                            | cancel twice                       | intent + fake cancel + reconcile | cancel event/result           | CANCELLED                      | cancel effect once               |
| 12 Timeout                                 | deterministic clock exceeds budget | cancel/reconcile                 | timeout Result                | TIMED_OUT or RECOVERY_REQUIRED | no premature terminal            |
| 13 Atomic rollback                         | injected DB failure mid-commit     | transaction rollback             | none/previous state           | unchanged                      | no half projection               |
| 14 Schema reopen                           | v0/new DB and current v1           | migrate/open                     | schema v1                     | projections readable           | idempotent reopen                |
| 15 Future schema                           | user_version > supported           | open                             | version error                 | unopened                       | no mutation                      |
| 16 Boundary                                | forbidden repo-local import        | static check                     | test failure                  | n/a                            | no core→cc-haha coupling         |

### 11.2 Commands required after implementation

Focused first:

```
bun test ./src/server/workbenchos/contracts.test.ts
bun test ./src/server/workbenchos/core/stateReducers.test.ts
bun test ./src/server/workbenchos/persistence/sqliteJournal.test.ts
bun test ./src/server/workbenchos/core/workbenchCore.contract.test.ts
bun test ./src/server/workbenchos/dependencyBoundary.test.ts
```

Then:

```
bun run check:impact
bun run check:server
bun run check:persistence-upgrade
git diff --check
```

`check:impact` 当前不会自动选择新 Workbench persistence path，所以第一实现必须先完成第 7.2 节的 quality-policy 修改。

如果之后声称 PR-ready，再运行：

```
bun run verify
```

本次 Analysis-only 任务没有运行上述测试。

## 12. Upstream Compatibility Plan

### 12.1 First slice merge surface

生产 cc-haha 源码改动：

```
none
```

首切片只新增隔离目录，并修改三个质量门禁文件。没有 runtime registration。

### 12.2 High-risk files

| File风险First slice            |                                                |           |
| ---------------------------- | ---------------------------------------------- | --------- |
| `ws/handler.ts`              | 私有 map、transport、permission、cancel 混合；极高 churn | untouched |
| `conversationService.ts`     | subprocess、SDK wire、session singleton          | untouched |
| `sessionService.ts`          | JSONL/index/retention/native session authority | untouched |
| `repositoryLaunchService.ts` | checkout/worktree 副作用                          | untouched |
| `server/index.ts`            | startup/shutdown/process handlers              | untouched |
| `router.ts`                  | 公共 API 路由；`/api/tasks` 已有含义                    | untouched |
| Electron/browser services    | native resources、cookies、DOM                   | untouched |

证据：

- [`conversationService.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/conversationService.ts:612) 的 submit seam 仅返回 boolean，不能满足 durable Workbench receipt。
- [`handler.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/ws/handler.ts:548) 持有大量进程内状态。
- [`events.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/ws/events.ts:187) 的 `ChatState` 不是 Workbench Run 状态。
- [`sessionService.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/sessionService.ts:4239) 会处理 workspace/session/native persistence。
- [`repositoryLaunchService.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/repositoryLaunchService.ts:777) 可产生 Git/worktree 副作用。

### 12.3 Future registration slice

仅在 deterministic core 评审通过后：

1. 新建单独 composition/adapter 模块。
2. 若暴露 API：
   - 新建 `api/workbench.ts`
   - 在 [router.ts](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/router.ts:90) 做一个 lazy registration
   - 不复用 `/api/tasks`；该资源已有 cc-haha task 语义
3. 在 [index.ts](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/index.ts:262) 附近注册 open/migrate/recover。
4. 必须在接受 Workbench 请求前完成 recovery checks。
5. 在 [index.ts](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/index.ts:654) 的 shutdown 路径显式等待 journal close。
6. 不得复制 `.catch(() => undefined)` 风格吞掉 Workbench startup failure。
7. `CcHahaRuntimeAdapter` 应依赖新抽取的 generic runtime facade，而非 handler 私有 map。

## 13. Development Sequence

### Phase 1 — Contracts and boundaries

- `contracts.ts`
- AgentPort/JournalPort
- semantic/version validation
- dependency-boundary test

Exit criteria：

- contract tests pass
- 没有 cc-haha internal import

### Phase 2 — Pure state machines

- Task reducer
- Run reducer
- typed invalid-transition result
- exhaustive transition tests

Exit criteria：

- 合法/非法状态矩阵确定
- reducer 无 IO、clock、UUID

### Phase 3 — SQLite journal

- schema v1
- open/close
- events/current projections/idempotency/results
- atomic batch commit
- reopen/recovery queries
- migration tests

Exit criteria：

- transaction rollback无半状态
- restart后 projection 和 events 一致
- future schema fail closed

### Phase 4 — WorkbenchCore

- inject journal/AgentPort/clock/IDs
- create Task/Run
- persist intent before side effect
- reconcile/cancel/recover

Exit criteria：

- crash windows由同一 key 恢复
- 一个 Task 最多一个 active Run

### Phase 5 — FakeAgentPort

- scripted status
- deterministic advancement
- failure injection
- call counters

Exit criteria：

- success/failure/cancel/timeout 可完全离线复现

### Phase 6 — Integrated contract tests

- end-to-end fake execution
- duplicate submission/result
- restart recovery
- dependency boundary

Exit criteria：

- `Task → Run → Fake → Result → Review` 确定性通过

### Phase 7 — Quality routing and final review

- persistence prefix/check routing
- persistence-upgrade lane entry
- focused tests
- `check:impact`
- `check:server`
- `check:persistence-upgrade`
- diff review

不进入 real runtime/browser integration。

## 14. Risks

### P0 — Premature production registration

修改 router/index 会把 isolated core slice 扩大为真实持久状态和生命周期变更。

Mitigation：首切片零注册。

### P1 — Persistence check routing gap

新 persistence 目录当前不会自动选择 persistence-upgrade lane。

Mitigation：同一 slice 修改 change policy、policy test 和 persistence gate。

### P1 — Side effect inside transaction

AgentPort 调用若放在 DB transaction 中，会导致锁持有、超时和不确定回滚。

Mitigation：先 commit intent，事务外调用，后续 reconcile。

### P1 — Direct cc-haha singleton dependency

会导致 dual authority、不可恢复状态和测试污染。

Mitigation：构造函数注入 AgentPort/JournalPort；architecture test 阻止 import。

### P1 — Duplicate native execution

未来真实 adapter 尚无已验证的跨重启 submission lookup。

Mitigation：真实 adapter slice 前必须提供 durable key lookup 或 generic runtime hook。

### P1 — Projection/event divergence

若 event 与 projection 分开写入，restart 可能得到冲突权威。

Mitigation：同一 SQLite transaction、projection version/checkpoint、recovery validation。

### P2 — Overbuilt event sourcing

generic aggregate/event bus/migration framework 会扩大 M1。

Mitigation：固定 Task/Run reducers 和五个最小表，不做通用框架。

### P2 — Windows SQLite behavior

WAL、antivirus、文件复制和锁竞争可能引起 startup/close 异常。

Mitigation：单 writer、busy timeout、FULL sync、显式 close、temp-file tests。

### P2 — Schema evolution

V0.1 字段仍可小幅修订。

Mitigation：versioned payload JSON、schema version、unknown future version fail closed。

## 15. Open Questions

以下不阻塞首个 isolated slice：

1. **Production DB root**
   - 最终应由哪个现有 application-data resolver 提供？
   - 首切片通过显式 path injection 避免做此决定。
2. **Real runtime idempotency**
   - cc-haha 后续如何提供跨 server restart 的 submission-key lookup？
   - 该问题阻塞 `CcHahaRuntimeAdapter`，不阻塞 FakeAgentPort/core。
3. **Projection repair UX**
   - production 中检测到 irreconcilable projection/event corruption 后，由哪个 manual repair/backup-first 流程处理？
   - 首切片只需 fail closed 和返回诊断，不自动修复用户状态。

## 16. Final Recommendation

建议在 M0-03 评审通过后，批准一个隔离的 coding slice，条件为：

- 产品代码只新增 `src/server/workbenchos/**`
- 现有产品 runtime 文件零修改
- 唯一既有文件修改限于三个 persistence quality-gate 文件
- SQLite path 完全注入
- 无 import-time singleton
- 无 server/browser/provider 启动
- FakeAgentPort 确定性模拟全部 terminal outcomes
- events、idempotency 和 current projections 同事务
- restart/duplicate tests 必须通过
- real adapter、browser、API registration 保持 deferred

推荐决策：**PROCEED AFTER M0-03 REVIEW — ISOLATED CORE SLICE ONLY**。

## 17. Final Git State

最终只读检查：

```
git status -sb
## main...origin/main
?? docs/audits/
?? docs/reviews/

git diff --stat
<empty>

git diff --cached --stat
<empty>

git diff --check
<empty>
```

执行摘要：

- Files changed：`none`
- Repository files created：`none`
- Tests executed：`none — not run`
- Generated artifacts：`none`
- Dependencies installed：`none`
- Migrations run：`none`
- Branch created/switched：`no`
- Stage：`no`
- Commit：`no`
- Push：`no`
- Merge/rebase/reset/clean：`no`
- Secrets/cookies/tokens accessed：`no`
- Live service/provider/browser access：`no`
- Commands executed：
  - `Get-Content`
  - `rg --files`
  - `rg -n`
  - read-only Git preflight/status/diff commands
  - per-command `safe.directory` override without modifying Git config
- Required artifacts read：
  - [M0-01 Baseline Audit](file:///M:/vibecoding/Projects/WorkbenchOS/docs/audits/M0_01_CODEX_CC_HAHA_BASELINE_AUDIT_2026-09-21.md)
  - [M0-01 Architecture Review](file:///M:/vibecoding/Projects/WorkbenchOS/docs/reviews/M0_01_WORKBENCHOS_ARCHITECTURE_REVIEW_2026-09-21.md)
  - [M0-02 Contract Architecture Review](file:///M:/vibecoding/Projects/WorkbenchOS/docs/reviews/M0_02_WORKBENCHOS_CONTRACT_ARCHITECTURE_REVIEW_2026-09-22.md)

报告到此停止，不进入实现。