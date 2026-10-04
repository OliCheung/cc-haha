# M0-02 — WorkbenchOS M1 Contract & State Model Freeze

结论：建议冻结 M1 核心合同、状态机、幂等规则和持久化所有权；真实 `CcHahaRuntimeAdapter` 与 `ChatGPTWebAdapter` 保持 `PROVISIONAL`，待通用 hook 与可恢复幂等能力具备后再实现。

本任务仅完成分析与设计。未修改仓库、未运行实现测试、未访问凭据、未进入实现。

## 1. Execution Identity

- Actual agent：Codex
- Actual model family：GPT-5-based Codex
- Task-requested route：Sol
- Exact deployed model/SKU：`UNKNOWN`；当前运行环境未暴露可验证标识，因此不冒充已确认的 Sol SKU
- Reasoning strength：按任务包以 High 执行；精确运行时 telemetry 为 `UNKNOWN`
- Supporting investigation：两个只读代码探索任务，分别检查 server 和 desktop 边界

## 2. Git Preflight

| 项目实际结果                 |                                             |
| ---------------------- | ------------------------------------------- |
| Repository             | `M:\vibecoding\Projects\WorkbenchOS`        |
| Git top-level          | `M:/vibecoding/Projects/WorkbenchOS`        |
| Branch                 | `main`                                      |
| HEAD                   | `b8c7a11507c8da63f5c6745f7c27db99d6a313c0`  |
| origin                 | `https://github.com/OliCheung/cc-haha.git`  |
| upstream               | `https://github.com/NanmiCoder/cc-haha.git` |
| `main...origin/main`   | ahead `0`, behind `0`                       |
| `main...upstream/main` | ahead `0`, behind `0`                       |
| Working tree           | 仅有任务包允许存在的两份 M0-01 未跟踪文档                    |
| Unrelated changes      | 未发现                                         |

未跟踪文件：

- `docs/audits/M0_01_CODEX_CC_HAHA_BASELINE_AUDIT_2026-09-21.md`
- `docs/reviews/M0_01_WORKBENCHOS_ARCHITECTURE_REVIEW_2026-09-21.md`

首轮 Git 调用被 dubious-ownership 校验拦截。没有修改全局或仓库 Git 配置；后续命令仅使用一次性的：

```
git -c safe.directory=M:/vibecoding/Projects/WorkbenchOS ...
```

## 3. Architecture Constraints Carried Forward

1. WorkbenchOS 是 Task、Run、Approval、Recovery、Audit 和幂等控制面的权威。
2. cc-haha Session、CLI Task 或 browser tab 都不能成为 Workbench Task。
3. M1 核心位于现有 server 内的隔离模块。
4. ChatGPT 专用 DOM/页面逻辑留在 Electron main 的适配器中。
5. 核心只依赖窄、版本化、agent-neutral 的端口。
6. 核心不得暴露：
   - `WebContentsView`、DOM、selector、CDP handle
   - raw CLI stream-json
   - WebSocket 私有 map
   - cc-haha JSONL/SQLite 行
   - cookie、token、provider 环境变量
7. M1 只支持：
   - 一个 conversation
   - 一个 Task 一个时刻最多一个非终态 Run
   - 每个 Run 一个 execution agent
   - 显式 approval boundary
   - durable recovery
   - 不自动 commit、push 或创建分支/worktree
8. Workbench business approval 与 execution-agent/tool permission 是两个独立层次，不能互相替代。

## 4. Identity Model

### 4.1 身份与所有权

| 标识唯一范围生成/所有者重试间稳定性重启持久化备注 |                            |                            |              |   |                                     |
| ------------------------- | -------------------------- | -------------------------- | ------------ | - | ----------------------------------- |
| `project_id`              | Workbench 全局               | WorkbenchOS                | 稳定           | 是 | M1 中绑定一个目标 repository/workspace     |
| `task_id`                 | Workbench 全局               | Workbench Core             | 所有 Run 间稳定   | 是 | UUIDv7 或等价不可碰撞 ID                   |
| `run_id`                  | Workbench 全局               | Workbench Core             | 每次 retry 新建  | 是 | 不能复用失败 Run                          |
| `conversation_id`         | `browser_adapter_id` 命名空间内 | Browser adapter，opaque     | Task/Run 间稳定 | 是 | 与 tab、`browserTabId`、`storageId` 无关 |
| `agent_id`                | Workbench 注册表内             | Agent adapter registration | 可在不同 Run 间变化 | 是 | 不包含 vendor 状态语义                     |
| `model_id`                | `agent_id` 命名空间内           | 请求者/adapter                | 可在不同 Run 间变化 | 是 | opaque；M1 可省略以使用 adapter 默认值        |
| `protocol_version`        | 合同级                        | WorkbenchOS                | 固定           | 是 | V0.1 精确协商                           |
| `native_session_ref`      | `agent_id` 命名空间内           | Agent adapter              | 每个 Run 可变化   | 是 | opaque；不能替代 `run_id`                |
| `event_id`                | Workbench 全局               | Journal                    | 不适用          | 是 | 每个持久事件唯一                            |
| `result_id`               | Workbench 全局               | Workbench Core             | 一个 Run 最多一个  | 是 | ResultEnvelope 不可变                  |

### 4.2 基数

```
Project 1 ── N Task
Conversation 1 ── N Task
Task 1 ── N Run
Task 0 ── N Result
Run 1 ── 1 Task
Run 0 ── 1 Result
Run 1 ── 1 AgentPort binding
Run 0 ── 1 native_session_ref
```

附加约束：

- M1 一个 Task 同时最多有一个非终态 Run。
- 一个 native session 是否被多个 Run 复用由 adapter 决定；核心不得施加反向唯一约束。
- 每个 Result 必须同时包含 `task_id` 和 `run_id`。
- 每个 Event 必须包含 `task_id`；Run 相关事件还必须包含 `run_id`。
- `project_id` 和 `conversation_id` 通过 Task 查询，不要求重复出现在每个 Event/Result 中。

### 4.3 Canonical envelope 边界

`TaskEnvelope V0.1` 是 Workbench Core 接受并持久化后的 canonical envelope，不是原始 DOM 文本。

流程为：

```
ChatGPTWebAdapter observation
→ validate source marker/idempotency key
→ Workbench Core allocates task_id
→ persist canonical TaskEnvelope
```

原始消息、完整 transcript 或 DOM 不进入 TaskEnvelope，只保留 opaque evidence reference。

## 5. TaskEnvelope V0.1

```
type TaskEnvelopeV01 = {
  kind: 'workbench.task'
  protocol_version: '0.1'
  task_id: string
  project_id: string
  conversation_ref: {
    browser_adapter_id: string
    conversation_id: string
  }
  source_message_ref?: string
  idempotency_key: string
  requested_execution: {
    agent_id: string
    model_id?: string
    execution_timeout_ms: number
  }
  goal: string
  context_refs: EvidenceRef[]
  allowed_scope: {
    repository_relative_paths: string[]
    action_classes: string[]
  }
  forbidden_scope: {
    repository_relative_paths: string[]
    action_classes: string[]
  }
  validation_requirements: ValidationRequirement[]
  approval_requirements: ApprovalType[]
  stop_condition: 'RESULT_READY_FOR_REVIEW'
  created_at: string
  extensions?: Record<string, JsonValue>
}
```

### 5.1 Field contract

| 字段分类Owner验证与原因可见性              |             |                      |                                        |         |
| ------------------------------ | ----------- | -------------------- | -------------------------------------- | ------- |
| `kind`                         | REQUIRED_M1 | Core                 | 必须为固定 literal，防止 envelope 混淆           | Machine |
| `protocol_version`             | REQUIRED_M1 | Core                 | 必须精确支持 `0.1`                           | Machine |
| `task_id`                      | REQUIRED_M1 | Core                 | 全局唯一；重复不得重新分配                          | 可显示     |
| `project_id`                   | REQUIRED_M1 | Core                 | 必须解析为已绑定项目；不使用任意路径替代                   | 可显示     |
| `conversation_ref`             | REQUIRED_M1 | Browser adapter/Core | adapter ID 非空；conversation ID opaque   | Machine |
| `source_message_ref`           | OPTIONAL_M1 | Browser adapter      | 仅在 adapter 能提供稳定、不含凭据的引用时记录            | Machine |
| `idempotency_key`              | REQUIRED_M1 | Source/adapter       | conversation 命名空间内稳定、非空、有长度上限          | Machine |
| `requested_execution.agent_id` | REQUIRED_M1 | Requester/Core       | 必须匹配已注册且版本兼容的 AgentPort                | 可显示     |
| `model_id`                     | OPTIONAL_M1 | Requester/adapter    | opaque；不得包含 vendor-specific 配置结构       | 可显示     |
| `execution_timeout_ms`         | REQUIRED_M1 | Requester/Core       | 正整数并受平台上下限约束                           | 可显示     |
| `goal`                         | REQUIRED_M1 | Requester            | 非空、长度受限；是 Run 的唯一目标权威                  | User    |
| `context_refs`                 | REQUIRED_M1 | Requester/Core       | 数组可空；只接受持久 opaque refs，不嵌完整 transcript | 混合      |
| `allowed_scope`                | REQUIRED_M1 | Requester/Core       | 路径必须 repo-relative、规范化、无逃逸             | User    |
| `forbidden_scope`              | REQUIRED_M1 | Requester/Core       | 不得与 allow 产生不明确覆盖；禁止项优先                | User    |
| `validation_requirements`      | REQUIRED_M1 | Requester/Core       | 数组可空；每项有稳定 requirement ID              | User    |
| `approval_requirements`        | REQUIRED_M1 | Requester/Core       | 数组可空；只能增加、不能取消平台强制审批                   | User    |
| `stop_condition`               | REQUIRED_M1 | Core                 | V0.1 仅允许 `RESULT_READY_FOR_REVIEW`     | User    |
| `created_at`                   | REQUIRED_M1 | Core                 | UTC RFC3339，由 journal 接受时写入            | 可显示     |
| `extensions`                   | OPTIONAL_M1 | Namespaced owner     | key 必须 namespaced；未知扩展保存但不得驱动行为        | Machine |

### 5.2 Deferred Task fields

以下为 `DEFERRED`：

- agent team、candidate agents、routing weights
- dependency graph、workflow steps
- schedule/priority queue
- remote executor/device
- multi-repository transaction
- autonomous retry policy
- generalized policy DSL
- embedded transcript
- vendor-specific CLI flags

## 6. ResultEnvelope V0.1

```
type ResultEnvelopeV01 = {
  kind: 'workbench.result'
  protocol_version: '0.1'
  result_id: string
  task_id: string
  run_id: string
  executor: {
    agent_id: string
    model_id?: string
  }
  outcome: {
    status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out'
    completion: 'complete' | 'partial' | 'none'
    terminal_reason?: string
  }
  summary: string
  changed_files: FileChange[]
  commands: CommandEvidence[]
  validations: ValidationEvidence[]
  git_state: GitEvidence
  artifacts: EvidenceRef[]
  native_evidence_refs: EvidenceRef[]
  risks: string[]
  unresolved_work: string[]
  errors: NormalizedError[]
  next_action: {
    kind: 'none' | 'review' | 'retry' | 'user_action'
    summary?: string
  }
  started_at?: string
  finished_at: string
  recorded_at: string
  extensions?: Record<string, JsonValue>
}
```

### 6.1 Field rules

| 字段组分类规则                 |                             |                                                                             |
| ----------------------- | --------------------------- | --------------------------------------------------------------------------- |
| kind/version/IDs        | REQUIRED_M1                 | Result 与 Task/Run 必须匹配；一个 Run 只能有一个 immutable Result                        |
| `executor`              | REQUIRED_M1                 | 记录实际 adapter/模型，不仅是请求值                                                      |
| `outcome`               | REQUIRED_M1                 | 不得仅由 process exit code 推断                                                   |
| `summary`               | REQUIRED_M1                 | 对成功、失败、取消、超时都必须存在                                                           |
| `changed_files`         | REQUIRED_M1                 | 可为空；路径 repo-relative；不得读取或嵌入文件秘密                                            |
| `commands`              | REQUIRED_M1                 | 可为空；只记录经过脱敏的命令与结果，不记录环境变量                                                   |
| `validations`           | REQUIRED_M1                 | 每个 Task validation requirement 必须有 passed/failed/skipped/blocked/not_run 结果 |
| `git_state`             | REQUIRED_M1                 | 即使无法读取也返回 `unavailable` 及原因；显式记录 commit/push 是否发生                           |
| artifacts/evidence      | REQUIRED_M1                 | 数组可空；使用引用与 hash，不复制 native transcript                                       |
| risks/unresolved/errors | REQUIRED_M1                 | 数组可空；失败必须至少有一个 normalized error                                             |
| `next_action`           | REQUIRED_M1                 | 显式表达无后续或需 review/retry/user action                                          |
| timestamps              | REQUIRED_M1，`started_at` 可选 | 提交前失败可能没有 `started_at`                                                      |
| `extensions`            | OPTIONAL_M1                 | 未知扩展不得改变成功判断                                                                |

### 6.2 Terminal rules

- `succeeded`
  - `completion` 必须为 `complete`
  - 所有 REQUIRED validation 必须为 `passed`
  - `errors` 必须为空
- `failed`
  - `errors` 非空
  - `completion` 可为 `partial` 或 `none`
- `cancelled`
  - 必须有 cancellation reason
  - 不代表没有副作用；实际变更仍须列出
- `timed_out`
  - 只有确认 native execution 不再活动后才能终态化
  - 未确认停止时进入 `RECOVERY_REQUIRED`
- 没有文件变化
  - `changed_files: []`
  - 不使用虚构的 “no-op file”
- 部分执行
  - `completion: 'partial'`
  - 不能标记 `succeeded`
  - `unresolved_work` 必须非空

## 7. EventEnvelope V0.1

```
type EventEnvelopeV01<T> = {
  kind: 'workbench.event'
  protocol_version: '0.1'
  event_id: string
  sequence: number
  task_id: string
  run_id?: string
  event_type: EventType
  producer: {
    kind: 'core' | 'agent_adapter' | 'browser_adapter' | 'user'
    id: string
  }
  recorded_at: string
  dedupe_key: string
  payload_hash: string
  causation_event_id?: string
  payload: T
  extensions?: Record<string, JsonValue>
}
```

规则：

- `sequence` 由 journal 单调分配，是恢复顺序权威。
- ordering 只使用 `sequence`，不使用 adapter 提供的时间戳。
- `(producer.id, dedupe_key)` 唯一。
- 同 key、同 hash：返回已存在事件。
- 同 key、不同 hash：`IDEMPOTENCY_CONFLICT`，fail closed。
- `causation_event_id` 仅在一个事件由另一个事件确定性产生时使用。
- M1 不增加独立 `correlation_id`；`task_id`/`run_id` 已足够。
- 未知 top-level 字段拒绝；未知 namespaced extension 可保存但不执行。

### 7.1 最小事件分类

| Event证明的变化                  |                                                    |
| --------------------------- | -------------------------------------------------- |
| `task.created`              | 无 Task → `CREATED`                                 |
| `task.ready`                | `CREATED/BLOCKED/WAITING_REVIEW` → `READY`         |
| `task.blocked`              | 非终态 Task → `BLOCKED`                               |
| `run.created`               | 无 Run → `CREATED`；同时 Task `READY` → `RUNNING`      |
| `run.submission_requested`  | Run `CREATED` → `SUBMITTED`；持久化 side-effect intent |
| `run.native_bound`          | 不改变主状态；绑定 opaque native ref/receipt                |
| `run.started`               | `SUBMITTED` → `RUNNING`                            |
| `approval.requested`        | Run `SUBMITTED/RUNNING` → `WAITING_APPROVAL`       |
| `approval.resolved`         | `WAITING_APPROVAL` → 持久化的 `resume_state`           |
| `run.cancel_requested`      | 不立即终态化；记录 cancel intent                            |
| `run.recovery_required`     | 活动 Run → `RECOVERY_REQUIRED`                       |
| `recovery.reconciled`       | `RECOVERY_REQUIRED` → 已证明的活动状态                     |
| `run.result_recorded`       | 活动状态 → 一个 terminal Run state                       |
| `task.review_ready`         | Task `RUNNING` → `WAITING_REVIEW`                  |
| `result.delivery_requested` | 创建 durable browser-delivery intent                 |
| `result.delivered`          | delivery pending → delivered                       |
| `task.completed`            | `WAITING_REVIEW` → `COMPLETED`                     |
| `task.failed`               | `WAITING_REVIEW/BLOCKED` → `FAILED`                |
| `task.cancelled`            | 合法非终态 → `CANCELLED`                                |

不保留独立的 `run.failed`、`run.cancelled` 等事件；它们会与 `run.result_recorded` 产生双重终态权威。

## 8. Task State Machine

| State含义合法入站合法出站终态必需证据/恢复 |                                 |                                  |                                              |   |                                    |
| ------------------------ | ------------------------------- | -------------------------------- | -------------------------------------------- | - | ---------------------------------- |
| `CREATED`                | canonical Task 已原子持久化           | `task.created`                   | READY, CANCELLED                             | 否 | 完整 TaskEnvelope、ingestion key/hash |
| `READY`                  | 可创建新 Run，无活动 Run                | CREATED, BLOCKED, WAITING_REVIEW | RUNNING, BLOCKED, CANCELLED                  | 否 | scope/validation/approval 要求已验证    |
| `RUNNING`                | 存在唯一非终态 Run                     | READY                            | WAITING_REVIEW, BLOCKED, CANCELLED           | 否 | `active_run_id`                    |
| `WAITING_REVIEW`         | terminal Result 已记录，等待显式 review | RUNNING                          | COMPLETED, READY, BLOCKED, FAILED, CANCELLED | 否 | `result_id` 与 delivery projection  |
| `BLOCKED`                | 无法安全自动继续                        | READY, RUNNING, WAITING_REVIEW   | READY, FAILED, CANCELLED                     | 否 | blocker code、证据、所需用户动作             |
| `COMPLETED`              | review 明确接受                     | WAITING_REVIEW                   | 无                                            | 是 | review actor/event                 |
| `FAILED`                 | 明确结束且无有效完成/重试                   | WAITING_REVIEW, BLOCKED          | 无                                            | 是 | failure decision/result            |
| `CANCELLED`              | Task 被显式取消                      | 任意合法非终态                          | 无                                            | 是 | 活动 Run 已终止或不存在                     |

关键规则：

- Task state 是 Workbench journal 的权威投影，不是临时读取 Run 状态计算出来的 UI 值。
- Run 终态不会隐式完成 Task；Core 必须记录明确的 `task.review_ready`。
- `WAITING_APPROVAL` 属于 Run；Task 在等待 approval 时保持 `RUNNING`。
- `BLOCKED → RUNNING` 非法；必须先回到 `READY` 再创建新 Run。
- terminal Task 不得重新打开；后续工作创建新 Task。
- `READY → COMPLETED`、`RUNNING → COMPLETED`、任意 terminal → 非终态均非法。

## 9. Run State Machine

### 9.1 States

```
CREATED
→ SUBMITTED
→ RUNNING
↔ WAITING_APPROVAL
→ SUCCEEDED | FAILED | CANCELLED | TIMED_OUT

SUBMITTED | RUNNING | WAITING_APPROVAL
→ RECOVERY_REQUIRED
→ proven active state or terminal Result
```

### 9.2 Transition contract

| TransitionTrigger / producerEventIdempotencyRecovery |                                |                            |                                    |                                 |
| ---------------------------------------------------- | ------------------------------ | -------------------------- | ---------------------------------- | ------------------------------- |
| none → CREATED                                       | Core 创建首次尝试或显式 retry           | `run.created`              | `run-create:<task>:<attempt>`      | 重放返回同一 Run                      |
| CREATED → SUBMITTED                                  | Core 在调用 AgentPort 前持久化 intent | `run.submission_requested` | `agent-submit:<run>:v1`            | 重启后只使用同一 key                    |
| SUBMITTED → SUBMITTED + native ref                   | Adapter 返回 receipt             | `run.native_bound`         | receipt key/hash                   | 丢失 ack 时 lookup/same-key submit |
| SUBMITTED → RUNNING                                  | Adapter 提供肯定状态                 | `run.started`              | native status observation key      | 未知状态不得猜测                        |
| SUBMITTED/RUNNING → WAITING_APPROVAL                 | Core 或 adapter 请求 approval     | `approval.requested`       | `approval_id` + action fingerprint | 保存 `resume_state`               |
| WAITING_APPROVAL → resume state                      | exact approval resolved 并成功转交  | `approval.resolved`        | approval decision immutable        | 重启后重复转交同一决定                     |
| 活动状态 → RECOVERY_REQUIRED                             | native/binding 状态不确定           | `run.recovery_required`    | reconciliation checkpoint          | 禁止创建新 Run                       |
| RECOVERY_REQUIRED → 活动状态                             | 正面证据确认                         | `recovery.reconciled`      | evidence hash                      | 无正面证据则继续阻塞                      |
| 活动状态 → terminal                                      | immutable Result 被接受           | `run.result_recorded`      | `result:<run_id>`                  | 同 hash 返回原结果                    |
| 活动状态 → cancel pending                                | 用户/timeout 请求                  | `run.cancel_requested`     | `cancel:<run_id>`                  | 主状态不立即终态化                       |

### 9.3 Timeout、取消与失败

- `WAITING_APPROVAL` 暂停 `execution_timeout_ms`，但不暂停独立的 approval expiry。
- timeout 先记录 cancel intent 并调用 `cancel()`。
- 只有 adapter 证明 native run 已终止，才能写 `TIMED_OUT`。
- cancel 调用超时或状态未知时进入 `RECOVERY_REQUIRED`。
- native process crash 是 Run execution failure 或 recovery ambiguity，不自动等同于 Task failure。
- Run terminal 后不可改回 `RUNNING`。
- retry 必须创建新 `run_id`，不得复活失败 Run。

## 10. Idempotency Rules

| 操作Key / 生成者持久化点Duplicate 行为 |                                                                                  |                                           |                              |
| --------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------- |
| Task ingestion              | `(browser_adapter_id, conversation_id, idempotency_key)`；source/adapter 提供稳定 key | 与 `task.created` 同事务                      | 同 hash 返回原 Task；不同 hash 冲突   |
| Run creation                | `run-create:<task_id>:<attempt>`；Core                                            | 与 `run.created` 同事务                       | 返回原 Run                      |
| Native submission           | `agent-submit:<run_id>:v1`；Core                                                  | side effect 前的 `run.submission_requested` | AgentPort 必须返回同一 receipt     |
| Result recording            | `result:<run_id>`；Core                                                           | `run.result_recorded` 事务                  | 同 hash 返回原 Result；不同 hash 冲突 |
| Result delivery             | `delivery:<result_id>:<conversation>`；Core                                       | side effect 前的 delivery outbox            | 查找已有 marker；不得盲目重发           |
| Restart reconciliation      | `recovery:<run_id>:<checkpoint>`；Core                                            | reconciliation event                      | 重复 observation 不产生新副作用       |

### 10.1 Crash/replay scenarios

1. **Task 已持久化，响应 browser 前崩溃**
   - reload 后再次观察同一 Task。
   - Core 命中 ingestion key，返回原 `task_id`。
   - 不创建新 Task 或 Run。
2. **Submission intent 已写，调用 AgentPort 前崩溃**
   - restart 发现 `SUBMITTED` 且无 receipt。
   - 使用同一 submission key 调用 `lookupSubmission()`。
   - adapter 明确不存在时，才允许同 key `submitTask()`。
3. **Native side effect 已发生，`run.native_bound` 前崩溃**
   - 使用 submission key lookup，或重复调用具备 durable idempotency 的 `submitTask()`。
   - 返回同一 native ref。
   - 若 adapter 无法证明，进入 `RECOVERY_REQUIRED`；不得用新 key 重跑。
4. **Result 已记录，Task 尚未进入 WAITING_REVIEW**
   - replay 发现 terminal Result 与 Task projection 不一致。
   - 以 `result_id` 为因果源补写一次 `task.review_ready`。
5. **Browser 已提交 Result，但 `result.delivered` 前崩溃**
   - rebind 后使用 delivery marker 查找。
   - 找到则记录 delivered。
   - 未找到但证据不充分时保持 pending；不得自动重复提交。
6. **持久化事务中途崩溃**
   - SQLite 未提交事务整体回滚。
   - 不允许出现只有 dedupe reservation、没有对应事件的半状态。

## 11. Approval Representation

```
type ApprovalRecordV01 = {
  approval_id: string
  task_id: string
  run_id?: string
  type: ApprovalType
  requested_action: string
  action_fingerprint: string
  scope: JsonObject
  state: 'pending' | 'approved' | 'denied'
  requested_by: ActorRef
  resolved_by?: ActorRef
  requested_at: string
  resolved_at?: string
  expires_at?: string
  evidence_refs: EvidenceRef[]
  native_permission_ref?: string
}
```

M1 固定保护类型：

- `commit`
- `push`
- `merge`
- `branch_create`
- `worktree_create`
- `dependency_install`
- `privileged_command`
- `credential_access`
- `broad_filesystem_write`
- `external_browser_submit`

规则：

- approval 仅授权 exact `action_fingerprint` 和 scope。
- scope 变化、目标 conversation/remote/path 变化后必须重新审批。
- approval 记录不得包含 credential value。
- task 中的 approval requirement 只能增加保护，不能移除上述强制边界。
- Workbench approval 解决业务授权。
- cc-haha/tool permission 解决执行时工具调用许可。
- Workbench approval 不得设置或暗示 `bypassPermissions`。
- native permission 可通过 `native_permission_ref` 关联，但不能与 Workbench approval 共用一个状态记录。

## 12. Persistence Recommendation

### 12.1 方案比较

| 方案原子性/幂等恢复可读性Windows耦合决策 |                                    |                                |     |                        |    |        |
| ------------------------ | ---------------------------------- | ------------------------------ | --- | ---------------------- | -- | ------ |
| JSONL + snapshot         | 单写者可行，但 event/dedupe/outbox 原子组合较弱 | 可截尾恢复，需校验和与原子 rename           | 最佳  | append/rename/AV 干扰需谨慎 | 低  | 不选 M1  |
| Per-task JSON            | 多文件事务弱，竞争/丢更新风险高                   | 需复杂恢复协议                        | 好   | rename 仍需严谨            | 低  | 拒绝     |
| SQLite                   | 事务、唯一约束、outbox 最强                  | 自动回滚未提交事务，可 rebuild projection | 中等  | WAL/锁需单写者约束            | 低  | **推荐** |
| 复用 cc-haha persistence   | 无法提供 Workbench authority           | native schema 与生命周期不匹配         | 不稳定 | 取决于上游                  | 极高 | **拒绝** |

### 12.2 M1 source of truth

唯一权威：

- SQLite `events` 表中的 versioned Workbench EventEnvelope。
- canonical TaskEnvelope、ResultEnvelope 和 approval decision 作为事件 payload 的不可变内容。

可重建 projection：

- tasks
- runs
- approvals
- idempotency index
- delivery outbox
- result index

cc-haha 保持权威：

- native session/transcript
- runtime process
- CLI task/workflow/team/mailbox
- Git/worktree metadata
- browser cookie/login partition
- native indexes

### 12.3 Minimal layout

```
<resolved-app-state>/workbenchos/
  state-v0.1.sqlite3
  evidence/
    sha256/
      <bounded-workbench-owned-evidence>
```

不得放在 repository 或 `~/.claude` 数据结构中。

最小 schema：

```
meta(schema_version, protocol_version)
events(sequence, event_id, task_id, run_id, type, producer,
       dedupe_key, payload_hash, recorded_at, payload_json)
tasks_projection(...)
runs_projection(...)
approvals_projection(...)
idempotency(...)
delivery_outbox(...)
```

约束：

- 单 writer。
- `foreign_keys=ON`。
- WAL + `synchronous=FULL`。
- event insert、dedupe reservation、projection update、outbox update在同一事务。
- projection 校验失败时由 events rebuild。
- DB corruption 必须 fail closed；不得静默创建空库并重新运行 Task。
- live WAL 数据库不得通过普通文件复制作为备份。
- 生产状态目录的具体平台解析路径为 `PROVISIONAL`，通过依赖注入传入；测试只使用临时目录。

## 13. AgentPort V0.1

```
interface AgentPortV01 {
  readonly protocolVersion: '0.1'

  submitTask(
    input: AgentSubmissionV01,
    idempotencyKey: string,
    timeoutMs: number
  ): Promise<SubmissionReceipt>

  lookupSubmission(
    idempotencyKey: string,
    timeoutMs: number
  ): Promise<SubmissionReceipt | null>

  getStatus(
    nativeRunRef: string,
    timeoutMs: number
  ): Promise<AgentStatusSnapshot>

  collectResult(
    nativeRunRef: string,
    timeoutMs: number
  ): Promise<AgentResultMaterial | { status: 'not_ready' }>

  cancel(
    nativeRunRef: string,
    idempotencyKey: string,
    reason: string,
    timeoutMs: number
  ): Promise<CancelReceipt>

  healthCheck(timeoutMs: number): Promise<AgentHealth>
}
```

| Method行为           |                                                                                   |
| ------------------ | --------------------------------------------------------------------------------- |
| `submitTask`       | 异步提交并快速返回 receipt；同 key 必须 durable-idempotent                                     |
| `lookupSubmission` | 解决 side effect 已发生但 receipt 丢失的问题                                                 |
| `getStatus`        | 返回 accepted/running/waiting_approval/succeeded/failed/cancelled/timed_out/unknown |
| `collectResult`    | V0.1 的 authoritative pull path；未完成返回 `not_ready`                                  |
| `cancel`           | idempotent request，不等同于已终止                                                        |
| `healthCheck`      | 返回 port version、capabilities 和 availability，不发起真实执行                               |

统一错误：

```
VERSION_MISMATCH
INVALID_REQUEST
IDEMPOTENCY_CONFLICT
NOT_FOUND
UNAVAILABLE
TIMEOUT
PERMISSION_REQUIRED
UNSUPPORTED_CAPABILITY
INTERNAL
```

每个错误包含 `retryable` 和可选 evidence ref，不暴露 raw vendor wire data。

V0.1 使用 pull-based result/status。Adapter 内部可以消费 native event stream，但 event subscription 不进入 V0.1 公共 port；streaming 留待后续。

## 14. BrowserAutomationPort V0.1

```
interface BrowserAutomationPortV01 {
  readonly protocolVersion: '0.1'

  bindConversation(input: ConversationBindingRequest): Promise<ConversationBinding>
  rebindConversation(conversationRef: ConversationRef): Promise<ConversationBinding>

  pollObservations(
    bindingRef: string,
    cursor?: string
  ): Promise<BrowserObservationBatch>

  deliverResult(
    bindingRef: string,
    result: OutboundResultMessage,
    idempotencyKey: string,
    approvalRef: string
  ): Promise<DeliveryReceipt>

  lookupDelivery(
    conversationRef: ConversationRef,
    idempotencyKey: string
  ): Promise<DeliveryReceipt | null>

  captureEvidence(
    bindingRef: string,
    request: BoundedEvidenceRequest
  ): Promise<EvidenceRef>

  healthCheck(): Promise<BrowserHealth>
}
```

Core 只能看到：

- opaque conversation/binding reference
- normalized lifecycle：ready、navigating、rebind_required、crashed、closed、unavailable
- navigation generation
- validated task observation
- delivery receipt
- bounded evidence reference

Core 不能看到：

- selector、DOM node、HTML document
- arbitrary JavaScript
- `WebContentsView`、webContents ID
- Electron session/cookie objects
- CDP/debugger handle
- browser profile路径或 token

`deliverResult` 只允许语义明确的 ResultEnvelope delivery，不是通用浏览器脚本接口。

## 15. CcHahaRuntimeAdapter Boundary

| Workbench 概念Port operation当前 cc-haha seam判定 |                               |                                                                                                                                                 |                                            |
| ------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| native submit                               | `submitTask`                  | [`conversationService.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/conversationService.ts:612) 有 `messageUuid`/commit 边界 | 需 facade 与 durable key mapping             |
| submission lookup                           | `lookupSubmission`            | 当前去重仅进程内，且 handler 每次生成新 UUID                                                                                                                   | `GENERIC_HOOK_REQUIRED`                    |
| status/events                               | `getStatus`                   | [`events.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/ws/events.ts:64) 与 handler 内存态                                              | adapter 归一化；需稳定 facade                     |
| collect result                              | `collectResult`               | stream fragments + completion + transcript ref                                                                                                  | `PROVISIONAL`；稳定 pull seam 建议 generic hook |
| cancel                                      | `cancel`                      | session-scoped stop/interrupt/强杀与 task stop                                                                                                     | 需 run-scoped facade                        |
| permission                                  | approval/status translation   | tool permission 与 Computer Use 各自有 native shapes                                                                                                | adapter 映射；不得暴露 `PermissionMode`           |
| workspace/repository                        | AgentSubmission workspace ref | [`repositoryLaunchService.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/repositoryLaunchService.ts:100)                   | 只返回 opaque projection                      |
| session reference                           | submission receipt            | [`sessionService.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/sessionService.ts:180)                                     | opaque `native_session_ref`                |
| transcript/evidence                         | EvidenceRef                   | session metadata/transcript locator                                                                                                             | 保存引用，不读取/复制内容                              |
| health                                      | `healthCheck`                 | 五个目标文件中无稳定 seam                                                                                                                                 | `GENERIC_HOOK_REQUIRED`                    |

当前 native 状态包括 `idle`、`thinking`、`streaming`、`tool_executing`、`permission_pending`、`review`、`completed`、`failed`、`stopped` 等多个不一致集合。它们必须由 adapter 映射，不能成为 Run 状态枚举。

Workbench Core 不得直接 import：

- `src/server/ws/handler.ts`
- `src/server/services/conversationService.ts`
- `src/server/ws/events.ts`
- `src/server/services/sessionService.ts`
- `src/server/services/repositoryLaunchService.ts`

前四项尤其是高 churn/private wire 边界。Adapter 也应优先依赖新抽取的 generic runtime facade，而不是复制私有 map。

### Desktop boundary evidence

现有 browser service 能提供生命周期、导航、截图和 bounded snapshot；但没有 conversation bind、幂等 submit、task/result detector 或 crash rebind。`storageId` 不是 conversation ID 或 cookie partition：

- [`workspaceBrowser.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/desktop/electron/services/workspaceBrowser.ts:28)
- [`workspaceBrowser.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/desktop/electron/services/workspaceBrowser.ts:634)
- [`workspace/types.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/desktop/src/lib/workspace/types.ts:75)
- [`workspace/persistence.ts`](file:///M:/vibecoding/Projects/WorkbenchOS/desktop/src/lib/workspace/persistence.ts:184)

因此以下为 `GENERIC_HOOK_REQUIRED`：

- conversation-aware bind/rebind
- normalized task observation callback
- bounded semantic text delivery
- delivery lookup by idempotency marker
- browser adapter health
- crashed view recreate/rebind lifecycle

ChatGPT selector、composer、DOM parsing 与 completion detection 保持 adapter-specific。

## 16. Recovery Invariants

核心不变量：

> Recovery 优先避免重复副作用，不因状态不确定而静默重跑。

| 场景持久证据Reconciliation新 approval自动 replay记录事件 |                                        |                                          |                     |                      |                                                 |
| ------------------------------------------- | -------------------------------------- | ---------------------------------------- | ------------------- | -------------------- | ----------------------------------------------- |
| Workbench server restart                    | events、outbox、idempotency              | rebuild projections；逐个 reconcile 非终态 Run | 否                   | 仅 same-key operation | `recovery.reconciled` 或 `run.recovery_required` |
| Electron restart                            | conversation ref、delivery intent       | 重新 bind；先 lookup delivery                | exact approval 未变则否 | 禁止盲发                 | recovery/delivery event                         |
| Browser tab reload                          | conversation ref、navigation generation | 使旧 binding 失效并 rebind                    | 否                   | 先查 marker            | `recovery.reconciled`                           |
| Browser crash                               | crash observation、pending delivery     | 标记 binding lost；重建后 lookup               | target 改变时需要        | 否，直到确认               | `run.recovery_required` 或 delivery pending      |
| Native process disappears                   | submission key、native ref、最后状态         | 查询 status/result；区分 absent 与 unknown     | 创建新 Run 前需要         | 只允许 same-key 且证明未执行  | `run.recovery_required`                         |
| Result 已存在、Workbench 未记录                    | native result ref/hash                 | 归一化并原子写一次 Result                         | 否                   | 允许收集，不重执行            | `run.result_recorded`                           |
| Workbench 显示 submitted、无 process            | submission intent                      | lookup by key；证明未提交才 same-key submit     | 不需要；新 key 需要        | 有正面 absent 证据才允许     | recovery event                                  |
| restart 后重复观察 ChatGPT Task                  | ingestion key/hash                     | 返回原 Task/Result                          | 否                   | 不创建 Run              | 可记录 dedupe metric，不新增业务事件                       |
| pending approval 重启                         | durable approval record                | 恢复 pending；不得自行 approve/deny             | 仍需原 actor           | 不重做受保护动作             | approval event                                  |
| journal/DB corruption                       | integrity failure                      | fail closed，停止 orchestration             | 用户恢复操作需要            | 禁止                   | diagnostic evidence                             |

## 17. Contract-Test Plan

所有测试使用 deterministic clock/UUID、temporary state directory、SQLite test DB、FakeAgentPort、FakeBrowserPort；禁止网络、真实登录、provider、cookie 和真实用户配置。

| FamilyInputProcessingArtifactStateValidation |                                  |                              |                        |                                       |                          |
| -------------------------------------------- | -------------------------------- | ---------------------------- | ---------------------- | ------------------------------------- | ------------------------ |
| 1 Task validation                            | 合法/缺字段/路径逃逸 envelope             | schema + semantic validation | accepted event 或 error | CREATED/none                          | 非法输入零持久化                 |
| 2 Version                                    | `0.1`、未知版本                       | exact negotiation            | version error          | unchanged                             | fail closed              |
| 3 Duplicate task                             | 同 key 同/不同 payload               | dedupe + hash                | 一份/冲突                  | 一个 Task                               | 不创建第二 Task               |
| 4 Run transitions                            | 合法 sequence                      | reducer replay               | ordered events         | expected states                       | 每步确定                     |
| 5 Invalid transitions                        | terminal→running 等               | reducer rejection            | rejection evidence     | unchanged                             | journal 无非法 event        |
| 6 Fake submit                                | READY Task                       | create + submit              | receipt/native ref     | SUBMITTED/RUNNING                     | fake 调用一次                |
| 7 Duplicate native submit                    | crash/replay same key            | lookup/re-submit             | same receipt           | one Run                               | side effect count=1      |
| 8 Result normalization                       | successful native material       | normalize + validate         | ResultEnvelope         | SUCCEEDED/WAITING_REVIEW              | required evidence 完整     |
| 9 Failure normalization                      | error/partial changes            | normalize                    | failed Result          | FAILED/WAITING_REVIEW                 | partial 不标 success       |
| 10 Cancellation                              | duplicate cancel/late result     | cancel reconciliation        | cancel events/result   | CANCELLED 或 recovery                  | 未确认停止不终态化                |
| 11 Approval                                  | pending/approve/deny             | fingerprint + exact scope    | ApprovalRecord/events  | WAITING_APPROVAL/resume               | scope 改变失效               |
| 12 Restart/replay                            | 每个 crash checkpoint              | reopen DB/rebuild            | same projections       | stable                                | 无重复副作用                   |
| 13 Journal fault                             | interrupted txn/corrupt DB       | rollback/integrity check     | diagnostic             | prior committed state/blocked         | 不创建空 authority           |
| 14 Duplicate delivery                        | side effect 前后崩溃                 | outbox + marker lookup       | one receipt            | delivered once                        | browser submit count=1   |
| 15 Adapter mismatch                          | port version/capability mismatch | health negotiation           | normalized error       | Task BLOCKED/Run absent               | 不调用 submit               |
| 16 Browser rebind                            | reload/crash/new generation      | invalidate + rebind          | new binding ref        | delivery preserved                    | 旧 generation response 丢弃 |
| 17 Authority isolation                       | conflicting native session state | adapter mapping              | evidence ref           | Workbench state unchanged until event | Session 不覆盖 Task         |

每个测试都明确断言：

```
Input → Processing → Artifact → State → Validation
```

## 18. Deferred / Non-Goals

M1 不冻结：

- multi-agent routing、teams、mailbox
- agent selection optimization
- scheduling/cron
- distributed/remote execution
- cross-device synchronization
- autonomous cross-agent retry
- workflow DSL
- generalized policy DSL
- automatic commit/push/merge
- browser automation framework
- arbitrary browser scripting
- multiple simultaneous conversations
- complex UI state
- long-term memory/context engine
- final artifact ontology
- live streaming ResultEnvelope
- embedded transcripts
- vendor-specific agent status/flags
- production ChatGPT selector/completion heuristics

## 19. Open Questions

以下不阻塞 first core slice，但阻塞真实 adapter：

1. **Native submission lookup**
   - cc-haha 当前是否能提供跨 server restart 的 `idempotency_key → native session/run` durable lookup？
   - 若不能，真实 `CcHahaRuntimeAdapter` 不得上线；必须先提供 generic hook。
2. **Browser delivery verification**
   - ChatGPTWebAdapter 能否在 reload/crash 后可靠识别 conversation 和既有 delivery marker？
   - 未经 deterministic fake-page 合同与后续明确授权的真实验证前，不得声称 exactly-once。

没有会阻塞 `contracts + state machine + journal + fake AgentPort` 的开放问题。

## 20. Freeze Recommendation

| Design area决策                              |                                         |
| ------------------------------------------ | --------------------------------------- |
| Identity ownership/cardinality             | `FREEZE_V0_1`                           |
| TaskEnvelope core fields                   | `FREEZE_V0_1`                           |
| ResultEnvelope core fields                 | `FREEZE_V0_1`                           |
| EventEnvelope/order/dedupe                 | `FREEZE_V0_1`                           |
| Task state machine                         | `FREEZE_V0_1`                           |
| Run state machine                          | `FREEZE_V0_1`                           |
| Idempotency/crash policy                   | `FREEZE_V0_1`                           |
| Approval representation                    | `FREEZE_V0_1`                           |
| SQLite event authority/projections         | `FREEZE_V0_1`                           |
| Exact platform state directory             | `PROVISIONAL`                           |
| AgentPort V0.1 surface                     | `FREEZE_V0_1`                           |
| CcHahaRuntimeAdapter implementation        | `PROVISIONAL`                           |
| BrowserAutomationPort core-visible surface | `FREEZE_V0_1`                           |
| ChatGPT DOM/binding/delivery mechanics     | `PROVISIONAL`                           |
| Multi-agent/workflow/policy DSL            | `DEFER`                                 |
| Real browser/runtime integration           | `DEFER` until deterministic core passes |

Freeze recommendation：**ACCEPT CORE FREEZE WITH ADAPTER GATES**。

## 21. Proposed First Implementation Slice

仅实现：

```
versioned contracts
+
Task/Run pure reducers
+
SQLite journal and projections
+
idempotency/outbox primitives
+
FakeAgentPort
+
deterministic contract tests
```

明确不包含：

- router/API 注册
- real `ConversationService` wiring
- WebSocket handler 修改
- Electron IPC
- ChatGPT adapter
- DOM/browser work
- live provider/model
- commit/push automation

## 22. Likely Files For First Implementation Slice

全部优先为新文件：

```
src/server/workbenchos/contracts/common.ts
src/server/workbenchos/contracts/taskEnvelope.ts
src/server/workbenchos/contracts/resultEnvelope.ts
src/server/workbenchos/contracts/eventEnvelope.ts

src/server/workbenchos/core/taskState.ts
src/server/workbenchos/core/runState.ts
src/server/workbenchos/core/idempotency.ts
src/server/workbenchos/core/approval.ts

src/server/workbenchos/persistence/journalStore.ts
src/server/workbenchos/persistence/sqliteJournal.ts

src/server/workbenchos/ports/agentPort.ts
src/server/workbenchos/testing/fakeAgentPort.ts

src/server/workbenchos/**/*.test.ts
```

首个切片不应修改：

- `src/server/ws/handler.ts`
- `src/server/services/conversationService.ts`
- `src/server/services/sessionService.ts`
- Electron/browser/IPC 文件
- `router.ts` 或 `index.ts`

## 23. Risks

1. **P1 — Duplicate native side effects**
   - 真实 cc-haha 尚无已验证的跨重启 submission-key lookup。
2. **P1 — Dual authority**
   - 把 Session/CLI Task/runtime status 当作 Workbench Task/Run 会破坏恢复。
3. **P1 — Approval conflation**
   - business approval 与 native tool permission 合并会形成权限绕过。
4. **P1 — Browser duplicate delivery**
   - reload/crash 后无法证明既有提交时，必须阻塞而非重发。
5. **P1 — Sensitive evidence**
   - command、error、screenshot、transcript ref 必须脱敏且有大小边界。
6. **P2 — SQLite corruption/Windows locking**
   - 需要单 writer、FULL sync、integrity check 和 fail-closed recovery。
7. **P2 — Adapter status loss**
   - 当前 cc-haha 运行态和 pending approval 大量存在内存中，server restart 后不可重建。
8. **P2 — DOM churn**
   - ChatGPT selector/completion 逻辑只能留在独立 adapter。
9. **P2 — Clock semantics**
   - approval wait 与 active execution timeout 必须分开累计，不能只比较单个 wall-clock deadline。

## 24. Validation Evidence

已读取：

- [M0-01 Baseline Audit](file:///M:/vibecoding/Projects/WorkbenchOS/docs/audits/M0_01_CODEX_CC_HAHA_BASELINE_AUDIT_2026-09-21.md)
- [M0-01 Architecture Review](file:///M:/vibecoding/Projects/WorkbenchOS/docs/reviews/M0_01_WORKBENCHOS_ARCHITECTURE_REVIEW_2026-09-21.md)
- [Root AGENTS.md](file:///M:/vibecoding/Projects/WorkbenchOS/AGENTS.md)
- [src/AGENTS.md](file:///M:/vibecoding/Projects/WorkbenchOS/src/AGENTS.md)
- [desktop/AGENTS.md](file:///M:/vibecoding/Projects/WorkbenchOS/desktop/AGENTS.md)

定向检查了任务包要求的全部源码：

- [conversationService.ts](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/conversationService.ts)
- [events.ts](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/ws/events.ts)
- [handler.ts](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/ws/handler.ts)
- [sessionService.ts](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/sessionService.ts)
- [repositoryLaunchService.ts](file:///M:/vibecoding/Projects/WorkbenchOS/src/server/services/repositoryLaunchService.ts)
- [workspaceBrowser.ts](file:///M:/vibecoding/Projects/WorkbenchOS/desktop/electron/services/workspaceBrowser.ts)
- [channels.ts](file:///M:/vibecoding/Projects/WorkbenchOS/desktop/electron/ipc/channels.ts)
- [capabilities.ts](file:///M:/vibecoding/Projects/WorkbenchOS/desktop/electron/ipc/capabilities.ts)
- [workspace/types.ts](file:///M:/vibecoding/Projects/WorkbenchOS/desktop/src/lib/workspace/types.ts)
- [workspace/persistence.ts](file:///M:/vibecoding/Projects/WorkbenchOS/desktop/src/lib/workspace/persistence.ts)

未运行测试：

- 状态：`not run`
- 原因：本任务为 Analysis/Design only，无实现变化；任务包禁止安装依赖与真实服务调用
- 未将“未运行”描述为 passed 或 failed

## 25. Final Git State

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

展开未跟踪文件后仍只有两份授权 M0-01 文档。tracked working tree 与 index 均无变化。

## 26. Execution Summary

- Actual agent：Codex
- Actual model：GPT-5-based Codex；精确 SKU `UNKNOWN`
- Reasoning：High task configuration；telemetry `UNKNOWN`
- Commands executed：
  - `Get-Content` 读取任务包、AGENTS 和两份 M0-01 文档
  - `rg --files` / `rg -n` 做定向文件与指令核验
  - `git rev-parse`
  - `git branch --show-current`
  - `git remote -v` / `git remote get-url`
  - `git status --short` / `git status -sb`
  - `git rev-list --left-right --count`
  - `git diff --stat`
  - `git diff --cached --stat`
  - `git diff --check`
- Tests executed：`none — not run`
- Changed files：`none`
- Generated/uploaded artifacts：`none`
- Dependency installation：`no`
- Branch create/switch：`no`
- Stage：`no`
- Commit：`no`
- Push：`no`
- Merge/rebase/reset/clean：`no`
- Secrets/cookies/tokens/browser profile access：`no`
- Live browser/provider/model request：`no`
- Remaining blockers：仅真实 runtime/browser adapter 的两个 integration questions；不阻塞 first core slice
- Final recommendation：冻结 M1 core V0.1；评审通过前不要实施，评审后也先做 fake-adapter deterministic core slice

报告到此停止，不进入代码实施。