# M0-01 — Codex cc-haha Baseline & Extension-Point Audit

Project: WorkbenchOS  
Audit ID: M0-01  
Audit Type: Baseline & Extension-Point Architecture Audit  
Executed By: Codex  
Model: GPT-5-based Codex  
Reasoning: High  
Execution Date: 2026-09-21  

Repository: `M:\vibecoding\Projects\WorkbenchOS`  
Baseline Branch: `main`  
Baseline HEAD: `b8c7a11507c8da63f5c6745f7c27db99d6a313c0`  
Upstream: `NanmiCoder/cc-haha`  
Working Tree at Audit: clean  

Audit Status: **GO WITH CONDITIONS**

> Source note:
> This document preserves the Codex audit result as an evidence artifact.
> The body below is the original audit content supplied by Codex, with no substantive architectural conclusions changed.
> This document is evidence, not the final WorkbenchOS architecture decision.
> Final decisions should be recorded separately in review/decision artifacts.

---

# M0-01 WorkbenchOS / cc-haha 基线与扩展点审计报告

**最终结论：GO WITH CONDITIONS**

仓库基线与任务包声明完全一致，工作树始终干净。WorkbenchOS M1 可在 cc-haha 上增量构建，但必须满足三项架构条件：

1. WorkbenchOS 拥有独立的 Task / Run / Approval / Recovery / Audit 控制面；不能把 cc-haha Session 或 CLI Task 当成 WorkbenchOS Task。
2. 编排核心应作为现有本地服务器内部的隔离模块运行；ChatGPT Web 适配器留在 Electron 主进程侧。
3. WorkbenchOS 只依赖窄、版本化的兼容端口，不直接依赖 WebSocket handler 私有状态、CLI stream-json、JSONL/SQLite 内部结构或 Electron `WebContentsView`。

唯一建议的下一步：**冻结 M1 的版本化端口、事件信封和最小持久化模型，然后再进入实现评审。**

---

## 1. Execution Identity

- Actual agent：Codex
- Actual model：GPT-5-based Codex
- 精确部署 SKU：**UNKNOWN**，当前会话未暴露该标识
- Reasoning strength：按任务包以 High 执行；精确运行时 effort telemetry：**UNKNOWN**

## 2. Git / Runtime Preflight

| 项目结果                   |                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Repository             | `M:\vibecoding\Projects\WorkbenchOS`                                                      |
| Git top-level          | `M:/vibecoding/Projects/WorkbenchOS`                                                      |
| Branch                 | `main`                                                                                    |
| HEAD                   | `b8c7a11507c8da63f5c6745f7c27db99d6a313c0` (`b8c7a115`)                                   |
| Origin                 | `https://github.com/OliCheung/cc-haha.git`                                                |
| Upstream               | `https://github.com/NanmiCoder/cc-haha.git`                                               |
| Tracking branch        | `origin/main`                                                                             |
| `main...origin/main`   | ahead `0`, behind `0`                                                                     |
| `main...upstream/main` | ahead `0`, behind `0`                                                                     |
| Initial working tree   | `## main...origin/main`，无未跟踪或修改文件                                                         |
| Bun                    | 未安装或不在 `PATH`                                                                             |
| Node                   | `v24.19.0`                                                                                |
| Node executable        | `C:\Users\OLI\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe` |

任务包给出的仓库、分支、HEAD、远端和 ahead/behind 基线均得到确认，没有触发停审条件。

## 3. Current cc-haha Runtime Map

```text
Electron main process
├─ BrowserWindow → React renderer
├─ WebContentsView → workspace/browser pages
├─ ElectronServerRuntime
│  └─ Bun local-server sidecar
│     ├─ HTTP API / WebSocket / H5
│     ├─ session, workflow, team, cron, index services
│     └─ ConversationService
│        └─ CLI process per active session
└─ optional adapter/PTY/browser resources
```

关键边界：

- Electron 主进程创建沙箱化窗口，启用 `contextIsolation`，关闭 renderer 的 Node 集成：`desktop/electron/main.ts:878`。
- `ElectronServerRuntime` 负责端口预留、server sidecar 启动、健康检查、停止及自动重启；连续失败阈值为三次：`desktop/electron/services/serverRuntime.ts:70`、`:261`、`:483`。
- Server 通过 `Bun.serve` 提供 `/health`、API、WebSocket、SDK proxy 和静态 H5：`src/server/index.ts:222`、`:260`。
- `ConversationService.startSession()` 用 `Bun.spawn` 启动 CLI，使用 stream-json 输入输出，并传入 workspace、runtime、permission 和 resume 信息：`src/server/services/conversationService.ts:300`、`:339`、`:447`。
- WebSocket 层处理用户输入、权限回答、运行时配置、同步、取消及后台任务停止：`src/server/ws/events.ts:19`、`src/server/ws/handler.ts:619`。
- 客户端断开时，活动任务不会立即终止；空闲后才进入 grace-period 清理。等待权限的会话有单独硬上限：`src/server/ws/handler.ts:737`、`:3785`。
- 正常关闭会停止 watcher/index、CLI session、浏览器页面和 PTY；异常崩溃后的所有子进程归属行为没有在本次只读审计中动态验证。

结论：现有 runtime 足以承担 M1 的执行底座，但 WebSocket handler 同时承担过多编排状态，不应成为 WorkbenchOS Core 的直接依赖面。

## 4. Browser / ChatGPT Web Seam Map

### 当前浏览器能力

- 使用 Electron `WebContentsView`；页面由主进程拥有：`desktop/electron/services/workspaceBrowser.ts:149`。
- 所有浏览器标签共享持久 Electron partition `persist:cc-haha-browser-app`。`storageId` 只是页面恢复标识，不是 cookie partition：`desktop/electron/services/workspaceBrowser.ts:28`、`desktop/src/lib/workspace/types.ts:95`。
- renderer 只能通过已验证的 IPC capability 调用导航、截图、快照、消息等操作：`desktop/electron/ipc/channels.ts:67`、`desktop/electron/ipc/capabilities.ts:189`。
- 远程页面不会收到本地 server token：`desktop/electron/main.ts:394`。
- 现有 preview agent 可以提取 selector、nth path、文本、边界框、样式和受限 HTML 片段：`desktop/src/preview-agent/metadata.ts:11`。
- CDP 当前只用于全页截图，不是通用自动化接口：`desktop/electron/services/workspaceBrowser.ts:827`。
- 页面切换时隐藏而非销毁，因此运行中的 DOM、表单、滚动和历史可暂时保留；显式关闭或 renderer reload 会销毁页面。
- 页面崩溃只会上报错误；未发现自动重建并恢复 ChatGPT 对话观察状态的实现。

### ChatGPT Web 所需能力与现状

| 能力 | 当前状态 | 建议 |
|---|---|---|
| 识别对话 | 可获得 URL/页面状态，但没有 ChatGPT 语义 | 以规范化 URL/对话 ID 建立适配器身份 |
| 检测新回复 | 无 ChatGPT 专用观察器 | 隔离的 DOM `MutationObserver` |
| 判断完成 | 无 | 适配器有限状态机；不要仅依赖单一 CSS selector |
| 提取结构化结果 | 有通用 DOM/截图能力，无协议 | 使用版本化 fenced-envelope，并保留原始证据 |
| 向同一对话提交文本 | 有受控脚本/消息能力，无 ChatGPT 实现 | 仅允许适配器定义的输入动作并要求用户授权 |
| 刷新/重连 | cookie 和 URL 可恢复，实时 DOM 状态不可恢复 | 重新识别当前对话、扫描幂等键和最后完成回复 |
| 提取失败证据 | 已有截图/DOM metadata | 保存截图、URL、导航 ID、受限 HTML 摘要和错误原因 |

推荐 seam：

- 在 Electron 主进程新增 `ChatGPTWebAdapter`。
- 绑定 `{browserTabId, navigationId, conversationId}`，避免跨导航使用过期 DOM 引用。
- 通过窄、类型化 IPC 向 orchestrator 输出事件，不暴露 cookie、token、任意 JavaScript 或通用 CDP。
- 在 `WorkspaceBrowserService` 增加通用页面生命周期/观察 hook；ChatGPT 特有 selector 和完成判定全部放在独立适配器。
- 提交使用 Workbench 幂等键；刷新后先查找已有任务/结果信封，再决定是否重试。

## 5. Orchestrator Capability Matrix

| EXISTING — 直接复用 | EXTEND — 窄扩展 | NEW — WorkbenchOS 所有 |
|---|---|---|
| Session 创建、恢复、历史 | 版本化 task/result envelope | Workbench Task / Run 状态机 |
| CLI spawn、cwd/env/runtime 配置 | 稳定 `CcHahaRuntimePort` facade | 独立 durable journal |
| WebSocket 流式事件和状态同步 | 统一 retry/timeout/recovery policy | Artifact/Evidence manifest |
| 生成取消和后台任务停止 | durable approval projection | Decision record |
| 工具权限请求/回答 | 通用 browser observer/action hook | Append-only audit event log |
| Git repository/worktree 操作 | 统一 agent-neutral 状态映射 | Idempotency/control-plane policy |
| Workflow/team/task 读取能力 | 对原生日志、session、workflow 的引用 | ChatGPT 语义适配器 |
| Cron/scheduling 基础设施 | 兼容层 contract tests | 非 Claude 执行适配器，留待后续 |
| Transcript/activity/trace | 可恢复结果索引 | 通用 context package |

禁止复制的现有权威数据：

- 完整对话消息、工具日志、CLI task 文件、workflow journal、team mailbox。
- WorkbenchOS 只保存它自己的业务状态以及 `ccHahaSessionId`、native task/workflow ID、worktree、transcript locator、artifact hash 等引用。

## 6. Agent Execution Seam

建议定义 agent-neutral 的 `AgentPort`：

```text
submitTask(input, idempotencyKey)
  -> { runId, nativeSessionId }

getStatus(runId)
  -> queued | running | waiting_approval
   | succeeded | failed | cancelled | timed_out

collectResult(runId)
  -> { resultEnvelope, evidenceRefs }

cancel(runId, reason)
  -> idempotent outcome

healthCheck()
  -> capability/status snapshot
```

首个实现为 `CcHahaRuntimeAdapter`：

- spawn/cwd/env/runtime：映射到 `ConversationService`。
- event/status/cancel：映射到新抽取的 runtime facade，而不是直接调用 `src/server/ws/handler.ts` 私有 map。
- workspace/worktree：映射到 `src/server/services/repositoryLaunchService.ts:777`。
- permission：保留现有 permission request/response 流程。
- PTY 文本不是规范化 agent 协议，`ElectronTerminalService` 不应被当成可靠执行端口。

为什么 cc-haha Session 不等于 WorkbenchOS Task：

- Session 是一个可多轮交互、可包含后台任务、workflow 和 team activity 的对话/执行容器。
- CLI Task 是 task-list scoped、状态仅为 `pending/in_progress/completed` 的 CLI-owned projection：`src/server/services/taskService.ts:1`。
- 一个 Workbench Task 可经历多次 Run、重试或 Session；一个 Session 也可承载多个任务。生命周期和基数均不相同。

## 7. Persistence / Source-of-Truth Map

| 数据 | 当前权威来源 | 重启行为 | WorkbenchOS 策略 |
|---|---|---|---|
| Session/transcript | `~/.claude/projects/.../{sessionId}.jsonl`；`sessionService.ts:6` | 按清理策略保留 | 保存引用，不复制 transcript |
| CLI Task | `~/.claude/tasks/<list>/<task>.json` | 持久 | 只作 native projection，不作 Workbench Task |
| Workflow definition/run | definition 文件 + session workflow journal | 可重建运行历史 | 保存 `workflowRunId` 引用 |
| Team/member/mailbox | `~/.claude/teams/...`，另有 cc-haha archive | 持久/轮询更新 | 不复制 roster/mailbox |
| Scheduled task | `~/.claude/scheduled_tasks.json` | 持久 | M1 不使用 |
| Cron run log | `~/.claude/scheduled_tasks_log.json` | 持久；可清理 stale running | 不作为 Workbench Run |
| Local indexes | `~/.claude/cc-haha/db/*.sqlite` | 持久但可重建 | 仅 projection/cache |
| Browser cookies/login | Electron persistent partition | desktop restart 后通常保留 | 保持 opaque；禁止读取凭据 |
| Workspace tab descriptors | renderer `localStorage` | URL/storageId/布局可恢复 | 不当作浏览器运行状态 |
| Live `webContents`、DOM、visit history | 进程内存 | 不保留 | 通过 URL/对话 ID/幂等键重建 |
| Active CLI/background maps | server 内存 | 不保证完整恢复 | Workbench journal 必须独立记录期望状态 |
| Git/worktree | Git repository/worktree metadata | 持久 | 通过 facade 引用 |

Workspace persistence 明确只保存导航描述，不保存 cookie、页面内容、`webContents` ID 或 PTY handle：`desktop/src/lib/workspace/persistence.ts:15`。恢复时浏览器和终端都会获得新的 runtime ID：`desktop/src/lib/workspace/persistence.ts:184`。写入由 renderer localStorage bridge 完成：`desktop/src/lib/workspace/persistenceBridge.ts:32`。

WorkbenchOS 仍需独立持久化：

- Project/Task/Run 标识及关系。
- Run 状态迁移和幂等键。
- Approval/Decision/Recovery checkpoint。
- Artifact/Evidence manifest。
- 仅引用原生 cc-haha 证据的 append-only audit log。

## 8. Permission / Security Map

现有权限模式包括 `default`、`acceptEdits`、`plan`、`bypassPermissions`、`dontAsk` 和兼容值 `auto`：`src/server/ws/events.ts:11`。

必须保留人工授权的边界：

- 首次选择/绑定 ChatGPT 账户与目标对话。
- 向外部网页提交内容，至少按 Task 建立明确授权范围。
- 文件系统越界写入、依赖安装、提权命令和凭据读取。
- 分支/worktree 创建、commit、push、merge。
- permission mode 升级，尤其是 `bypassPermissions`。
- 任何通用浏览器交互或外部副作用。

重要风险：`cronService` 会强制使用 `bypassPermissions`。M1 不应通过 cron 路径启动执行 agent：`src/server/services/cronService.ts:56`。

安全约束：

- ChatGPT adapter 不读取 cookie、token 或 Electron session 内部数据。
- renderer 不获得任意 `executeJavaScript`、CDP 或 local-server 凭据。
- Workbench business approval 与 CLI tool permission 分层记录；前者不能替代后者。
- 默认使用 `default` 或 `dontAsk`，不得静默继承 bypass。

## 9. Upstream Compatibility Map

### 推荐兼容边界

```text
WorkbenchOS Core
  ├─ AgentPort ─────────────── CcHahaRuntimeAdapter
  ├─ BrowserAutomationPort ── Electron ChatGPTWebAdapter
  ├─ WorkspacePort ────────── repositoryLaunchService facade
  └─ PermissionPort ───────── existing permission workflow
```

WorkbenchOS Core 永不直接依赖：

- `ws/handler.ts` 的私有 map、cleanup timer 和具体状态机。
- CLI SDK/stream-json 的原始消息形状。
- session JSONL、team/task/workflow 文件布局。
- SQLite projection schema。
- Electron `WebContentsView`、preview 全局对象和 cookie partition。
- provider 私有环境变量。

建议的通用 upstream hooks：

1. 从 WebSocket handler 抽取 `ConversationRuntimeFacade`：submit、subscribe、state、cancel。
2. 提供版本化 runtime event envelope。
3. 给 workspace browser 提供通用 page lifecycle/observer/action hook。

这些 hook 是通用能力，可作为上游 PR 候选，不应加入 WorkbenchOS 专属命名或策略。

### 冲突热点

在当前 HEAD 上按路径统计的历史提交数：

| 模块 | 提交数 | 风险 |
|---|---:|---|
| `src/server/ws/handler.ts` | 140 | 极高 |
| `conversationService.ts` | 106 | 极高 |
| `sessionService.ts` | 91 | 极高 |
| `src/server/index.ts` | 44 | 高 |
| `desktop/electron/main.ts` | 43 | 高 |
| `src/server/router.ts` | 32 | 中高 |
| IPC capabilities | 22 | 中高 |
| IPC channels | 18 | 中 |
| `teamService.ts` | 10 | 中 |
| `repositoryLaunchService.ts` | 8 | 中 |
| `workflowService.ts` | 4 | 中，但文件体积较大 |
| `workspaceBrowser.ts` | 3 | 新模块、近期快速演进，实质风险高 |

因此应把绝大部分新代码放入新模块，仅在 router、main 和 browser lifecycle 做单点注册。

### Upstream-sync regression contract

每次同步上游至少验证：

- adapter 编译和版本协商。
- `submit → running → result → idle` 完整事件顺序。
- cancel、timeout、disconnect/reconnect、幂等重放。
- permission pending/allow/deny 与重启恢复。
- browser navigation/refresh/crash 后观察器重绑定。
- adapter 不泄露 cookie/token 或任意脚本能力。
- Workbench journal 重启恢复，不重复提交 native run。
- worktree 隔离和 source-of-truth 不重复。
- 现有 server、Electron、desktop-host contract、agent-flow 和 persistence-upgrade 离线测试。

## 10. Recommended Minimal M1 Architecture

推荐任务包选项 **2：内部 server-owned service/module**。

组成：

- `WorkbenchOS Core`：server 内独立目录，拥有 Task/Run 状态机和 journal。
- `CcHahaRuntimeAdapter`：把现有 session runtime 投影为稳定 `AgentPort`。
- `ChatGPTWebAdapter`：Electron 主进程内运行，通过类型化端口输出观察结果。
- `Artifact/Evidence Manifest`：记录原生证据引用和 hash。
- API/WS facade：renderer/H5 只看到版本化 Workbench 消息。

优点：

- 可直接复用现有认证、API、WebSocket 和 session runtime。
- 无额外 sidecar 的启动、认证、升级和故障恢复复杂度。
- 独立目录和端口使后续拆成 sidecar 仍然可行。
- 持久 journal 缓解 server 同进程故障域问题。

M1 明确不包含：

- 多 agent 调度。
- 通用 workflow DSL。
- 多浏览器/多对话编排。
- Codex、CodeBuddy、WorkBuddy 等额外执行适配器。
- 自动 commit/push 或无监督权限升级。

## 11. Proposed First Implementation Slice

最小、可逆、可测试、上游友好的纵向切片：

1. 支持一个已有 ChatGPT 对话、一个 Workbench Task、一个执行 agent、一个 Run。
2. Electron adapter 识别版本化 task envelope，并在用户授权后提交。
3. Server journal 原子记录 `task_created → run_submitted → running → result_recorded → completed/failed`。
4. `CcHahaRuntimeAdapter` 复用现有 session runtime，返回结构化 result envelope 和 evidence references。
5. Electron adapter 将结果提交回同一对话；刷新后依靠 conversation ID 和 idempotency key 避免重复执行或重复提交。
6. 提取失败时保留 URL、navigation ID、截图、受限 DOM 摘要和错误原因。
7. 使用 fake ChatGPT page 和 fake runtime 做确定性 contract/integration tests；真实登录仅作为后续明确授权的手工 smoke test。

回滚方式：删除新模块及三个注册点即可；不迁移或修改现有 session/task/workflow 权威数据。

## 12. Exact Files Likely Affected By First Slice

### 新文件

- `src/server/workbenchos/core/types.ts`
- `src/server/workbenchos/core/orchestrator.ts`
- `src/server/workbenchos/core/journalStore.ts`
- `src/server/workbenchos/ports.ts`
- `src/server/workbenchos/adapters/ccHahaRuntimeAdapter.ts`
- `src/server/workbenchos/**/*.test.ts`
- `src/server/api/workbenchos.ts`
- `desktop/electron/services/chatgptWebAdapter.ts`
- `desktop/electron/services/chatgptWebAdapter.test.ts`

### 最小现有文件改动

- `src/server/router.ts:90`：注册 Workbench API。
- `src/server/index.ts:628`：如需启动时 journal recovery，只增加生命周期注册。
- `desktop/electron/ipc/channels.ts:67`：新增类型化 adapter channel。
- `desktop/electron/ipc/capabilities.ts:382`：payload 校验。
- `desktop/electron/main.ts:528`：注册 adapter。
- `desktop/electron/services/workspaceBrowser.ts:509`：仅加入通用 page lifecycle hook。
- `desktop/src/lib/desktopHost/types.ts`
- `desktop/src/lib/desktopHost/electronHost.ts`
- `desktop/src/lib/desktopHost/contract.test.ts`

应避免在首个切片直接编辑 `ws/handler.ts`、`conversationService.ts` 或 `sessionService.ts`；若 facade 无法在外部组合，再提交一个独立、通用的小型上游 hook。

## 13. Risks

- **P1 — 双重权威：**把 Session/CLI Task 当成 Workbench Task 会造成恢复、重试和审批状态冲突。必须由独立 Workbench journal 解决。
- **P1 — 高 churn 耦合：**直接依赖 `ws/handler.ts` 或 CLI 原始流会使每次 upstream sync 都成为破坏性升级。
- **P1 — 权限绕过：**复用 cron 执行路径会继承 `bypassPermissions`，不满足 M1 人工授权边界。
- **P1 — DOM 脆弱性：**ChatGPT DOM/ARIA 结构可变化；适配器必须版本化、隔离并保留失败证据。
- **P1 — 非幂等重放：**刷新或 server restart 可能导致重复执行/重复回复；任务和提交两侧都必须携带幂等键。
- **P2 — 同进程故障域：**内部 server 模块崩溃会影响 cc-haha server；需隔离错误并依靠 journal 恢复。
- **P2 — 浏览器崩溃恢复：**当前只报告 crash，没有自动重新创建并恢复语义观察器。
- **P2 — 新浏览器模块演进快：**提交历史少但刚引入，接口仍可能频繁变化。

## 14. Unknowns

- **UNKNOWN：**当前 ChatGPT 页面真实 DOM、ARIA、流式完成标记和异常页面形态；本次未登录或访问真实服务。
- **UNKNOWN：**ChatGPT 服务条款、速率限制和自动化策略对该具体用法的约束。
- **UNKNOWN：**Electron persistent partition 的精确磁盘位置；无必要且未打开用户 profile。
- **UNKNOWN：**server 非正常崩溃时各平台上 CLI 子进程是否必然随父进程退出。
- **UNKNOWN：**未来 upstream 是否会为内部 runtime/browser 接口提供正式稳定性保证。
- **UNKNOWN：**Bun 测试在本机 checkout 的实际结果；Bun 不可用且禁止安装。
- **UNKNOWN：**平台精确模型 SKU 和独立 reasoning telemetry。

## 15. Validation Evidence

已完成：

- 任务包指定 Git preflight。
- 根目录、`src`、`desktop`、`docs` 下适用的 `AGENTS.md` 检查。
- runtime、server、WebSocket、session、workflow、team、cron、Git/worktree、Electron browser、IPC、workspace persistence 和 preview-agent 源码追踪。
- 关键高 churn 文件的只读 Git 历史计数与近期变更检查。
- 浏览器持久化、进程清理、取消、权限、恢复和 source-of-truth 的跨层追踪。
- 最终 Git 状态和 diff 边界复核。

未执行测试：

- Bun 不可用。
- 安装依赖被任务明确禁止。
- 本任务是架构/source audit，不要求真实登录或 provider 调用。
- 未把“未运行测试”解释为代码失败。

## 16. Final Git State

最终命令结果：

```text
git status -sb
## main...origin/main

git diff --stat
<empty>

git diff --cached --stat
<empty>

git diff --check
<empty>
```

工作树和 index 均保持干净。

## 17. Execution Summary

- Changed files：`none`
- Commands executed：
  - `Resolve-Path`
  - `git rev-parse --show-toplevel`
  - `git branch --show-current`
  - `git rev-parse HEAD`
  - `git remote -v` / remote URL 查询
  - tracking branch 查询
  - `git status -sb` / `git status --short`
  - `git rev-list --left-right --count`
  - `bun --version`、`node --version`、runtime path 查询
  - `rg --files`、`rg -n`
  - `Get-Content` 只读源码检查
  - `git log`、`git rev-list --count HEAD -- <path>`
  - `git diff --stat`
  - `git diff --cached --stat`
  - `git diff --check`
- Tests executed：`none`
- Generated/uploaded artifacts：`none`
- Dependency installation：`no`
- Branch creation/switch：`no`
- Stage performed：`no`
- Commit performed：`no`
- Push performed：`no`
- Live login/provider request：`no`
- Repository modifications：`none`

审计到此停止，不进入任何代码实施。
