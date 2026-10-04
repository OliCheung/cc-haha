# P0-ROUTE-A — ChatGPT CDP 可行性取证（Route A: connectOverCDP）

## 元信息

| 项 | 值 |
|---|---|
| 任务包 ID | `P0-ROUTE-A` |
| 里程碑 | `P0`（ChatGPT CDP 可行性取证） |
| 依赖 | 无（独立取证）；参考 `DEVELOPMENT_PLAN.md` §7（P0-01~05 待回答问题）与 §13 风险（风控 / 前端改版） |
| 状态 | `IN_PROGRESS`（P0-08 已执行：稳定发送通道 `NOT VERIFIED`；`button[type="submit"][aria-label="发送"]` 经 recheck 不稳定；DOM `KeyboardEvent` 发送已证明被页面拦截 discard） |
| 预估改动 | 新增 **1** 个仓库内文件（`docs/recon/P0_CDP_RECON_2026-10-03.md`）；**零 `src/` 改动**；探针脚本仅存于 `$env:TEMP`（仓库外，不提交） |
| 授权依据 | `DEVELOPMENT_PLAN.md` §M4「P0 — ChatGPT CDP 可行性取证」+ 用户 2026-10-03 指示（选 3：转向 P0 Route A spike） |

> **本包是只读技术取证，不是实现。** 所有结论必须来自真实执行并附原始输出；任何「推测」必须标注为推测，并写成 §4.2 的判定分支。

> **执行者须知**：遇到本文件未覆盖的情况按 §6.3 停止并报告，**不要自行决定设计**。

---

## 1. 目标

用**只读**方式验证如下链路是否可行，并产出可据以决策 M4 的证据包：

```
CC-Haha 内置 Chromium
  → remote debugging / CDP
  → Playwright connectOverCDP
  → 定位 ChatGPT Web
  → 确认现有登录态
  → 读取现有对话内容
  → 发送测试消息
  → 等待并读取 ChatGPT 回复
```

本包一次性覆盖 `DEVELOPMENT_PLAN.md §7` 的 `P0-01`~`P0-05` 五个待回答问题。

---

## 2. 非目标（同时是硬约束）

以下**明确不做**（对应 2026-10-03 的 8 条要求）：

1. 不做任何项目代码改动（`src/**`、`desktop/**` 一律不碰）——**只读 / 零项目代码改动**
2. 不修改 `M1-001` 的任何文件
3. 不实现完整 Orchestrator
4. 不实现 WorkerAdapter
5. 不实现自动 Loop
6. 不进行任何自动连续提交（绝不执行 `git add/commit/push/...`）
7. `external_browser_submit` **仍保持强制人工审批门**——本包不调用、不模拟、不绕过该门
8. 不在本包内预先决定 M4 的实现范围（只记录事实，决策留待 P0 成功后）

---

## 3. 前置条件

| # | 条件 | 验证命令 | 期望 |
|---|---|---|---|
| 1 | 本机有可用 Node.js | `& "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" --version` | 输出版本号（已知 22.22.2-3） |
| 2 | CC-Haha 桌面应用可启动或已在运行（内置 Chromium） | 见 Step 1 进程侦察 | 找到 cc-haha / chromium 进程或安装路径 |
| 3 | 可 attach 到 CDP | 见 Step 2 | 能取到 `webSocketDebuggerUrl` |
| 4 | ChatGPT Web 已登录（或用户配合登录） | 见 Step 4 | 页面显示已登录态 |

**任一前置不满足**：在 recon 文档中记录具体缺哪条，判定 `blocked`，停止并报告，**不擅自改变启动方式之外的环境**。

---

## 4. 允许新增的文件

```
docs/recon/P0_CDP_RECON_2026-10-03.md      # 证据包（仓库内，随本包产出）
$env:TEMP\p0_cdp_probe.mjs                 # 探针脚本（仓库外，不提交，不计入项目改动）
```

**仅这两个。其余一律不得新增或改动。**

---

## 5. 允许修改的既有文件

**无。**

---

## 6. 禁止触碰

| 类别 | 禁止项 |
|---|---|
| 路径 | `src/**`、`desktop/**`、`M1-001` 相关文件、任何生产/测试代码 |
| Git | 任何 `git` 写操作（`add`/`commit`/`push`/`merge`/`rebase`/`reset`/`clean`/`stash`）；不改 Git 配置 |
| 凭据 | 不读取/写入任何账号、密码、token、密钥、cookie；不访问 cookie / localStorage 内容用于持久化 |
| 实现 | 不写 Orchestrator / WorkerAdapter / 自动 Loop 的代码 |
| 审批门 | 不调用、不模拟 `external_browser_submit` 的自动动作（保持人工审批） |

---

## 7. 执行步骤

### Step 1 — 环境侦察（只读）
**做什么**：确认 Node、Playwright 可用性、cc-haha / Chromium 进程与是否已暴露 remote-debugging 端口。
**写到哪里**：recon 文档 §1 环境与工具。
**必须包含**（逐项）：
1. Node 版本（命令见 §9）
2. Playwright 是否可解析（`node -e "require.resolve('playwright')"`）；`npx --no-install playwright --version` 结果
3. 进程列表：名称匹配 `chrom|electron|haha|cc` 的进程（Name/Id/MainWindowTitle）
4. 监听端口：9222 / 9229 / 9333 是否有 LISTEN
5. cc-haha 安装路径（在 `Program Files`、`AppData\Local\Programs` 等枚举）
**期望结果**：得到 (a) Playwright 可用/不可用 的确定结论；(b) cc-haha 是否在跑、其 Chromium 是否带 remote-debugging。
**失败处理**：若 cc-haha 未运行，记录 `blocked` 并明确告知用户需先启动；**不擅自修改其启动参数以外的环境**。

**不确定项**：Playwright 是否可用
**判定方法**：Step 1 第 2 条命令
**分支 A（可用）**：直接进入 Step 2
**分支 B（不可用）**：**不擅自 `npm install` 生产依赖**（C-13）。改用 **Node 22 内置全局 `WebSocket` + `fetch` 直接实现 CDP 客户端**（零新增依赖，符合 C-13）；在 recon 记录此决策。若 CDP 端口也未暴露，则判定 `blocked`（见 Step 2）
**两分支都不匹配**：停止，输出原始输出，报告 `blocked`

### Step 2 — 定位 / 启动 CDP
**做什么**：若已暴露端口（如 9222），读取 `http://127.0.0.1:9222/json/version`；若未暴露，记录「需用户以 `--remote-debugging-port=9222` 重新启动 cc-haha」并停止（不自行改启动方式之外的东西）。
**写到哪里**：recon 文档 §2 CDP 连接稳定性 + §3 目标识别。
**必须包含**：`webSocketDebuggerUrl` 原始值；若不可达，原始错误。
**期望结果**：拿到有效的 `webSocketDebuggerUrl`。
**失败处理**：连接失败 → 记录原始错误，判定 `blocked`。

### Step 3 — Playwright connectOverCDP 并定位 ChatGPT Web
**做什么**：用 `$env:TEMP\p0_cdp_probe.mjs`（纯 Node，依赖 Node 22 全局 `WebSocket` + `fetch`，**不引入 Playwright**）连接 `wsUrl`，列出所有 target，按 URL 识别 ChatGPT Web（含 `chatgpt.com` / `chat.openai.com`）。
**写到哪里**：recon 文档 §3 目标识别。
**必须包含**：targets 列表摘要；ChatGPT Web target 的识别依据；与 cc-haha 自身窗口/app 内其他页面区分的方法。
**期望结果**：能稳定从 targets 中唯一识别 ChatGPT Web 页面。
**失败处理**：无法区分 → 记录，判定 `blocked`。

### Step 4 — 确认现有登录态
**做什么**：在 ChatGPT Web target 内读取页面信号，判断是否已登录（如头像、侧栏「新聊天」、无登录墙）。
**写到哪里**：recon 文档 §4 登录态确认。
**必须包含**：判定所依据的 DOM / 文本信号；结论（已登录 / 未登录 / 不确定）。
**期望结果**：得到确定登录态结论。
**失败处理**：信号模糊 → 标注「不确定」，不臆断。

### Step 5 — 读取现有对话内容
**做什么**：用 DOM / 无障碍树定位当前对话最后一条消息，取回其文本（含代码块）。
**写到哪里**：recon 文档 §5 页面/DOM 结构 + §6 消息读取方式。
**必须包含**：关键 selector / 无障碍路径；取回文本样例（至少 1 条，含代码块时做逐字节比对）。
**期望结果**：能取到最后一条消息文本，且结构可被稳定定位。
**失败处理**：取不到 → 记录，判定 `blocked` 或标注受限。

### Step 6 — 发送测试消息
**做什么**：定位输入框，通过**真实输入事件**（非直接 `el.value=`）填入并触发发送（如 `Enter` 或发送按钮），内容须为明显测试性语句（如「[P0 probe] 请只回复：p0-ok」）。
**写到哪里**：recon 文档 §7 消息发送方式。
**必须包含**：输入框定位方式、输入事件方式、发送动作；是否触发任何风控提示。
**期望结果**：测试消息成功投递。
**失败处理**：发送失败 / 风控拦截 → 记录原始现象，判定 `blocked` 或标注。

### Step 7 — 等待并读取回复
**做什么**：轮询检测「生成结束」（停止动画 / 无 pending 标记 / 特定按钮态），取回 ChatGPT 回复文本。
**写到哪里**：recon 文档 §8 响应完成检测方式。
**必须包含**：完成判定所用信号；采样次数与判定结果；取回的回复文本（应为 `p0-ok` 或等效）。
**期望结果**：能可靠判定结束并取回回复。
**失败处理**：判定不稳定 → 记录误判次数，按 §8 验收标准如实计入。

### Step 8 — 记录稳定性 / 失败 / 超时
**做什么**：贯穿上述各步，记录每次 CDP 断开、重连、超时、报错。
**写到哪里**：recon 文档 §9 失败与超时。
**必须包含**：每条异常的原始现象 + 可能原因。
**期望结果**：形成可复现性结论。
**失败处理**：N/A（本身就是记录失败）。

---

## 8. 验收标准

| # | 断言 | 对应 P0 | 原始证据要求 |
|---|---|---|---|
| 1 | CDP 可 attach：`/json/version` 返回 `webSocketDebuggerUrl`，且 `connectOverCDP` 成功 | P0-01 | 粘贴 version 输出 + 连接成功日志 |
| 2 | 能与 cc-haha 自身窗口区分，稳定唯一识别 ChatGPT Web target | P0-01 | targets 列表 + 识别依据 |
| 3 | 回复提取保真：最后一条回复文本可取回，代码块逐字节一致 | P0-02 | 取回文本样例 + 比对结果 |
| 4 | 完成判定稳定：≥20 次采样误判率=0（或记录实际误判数） | P0-03 | 采样记录表 |
| 5 | 投递可达 + conversation 标识可稳定识别 | P0-04 | 发送成功 + 当前 conversation 识别依据 |
| 6 | 登录态结论明确（已登录 / 未登录） | P0-05 | §4 信号记录 |
| 7 | 零生产代码改动：`git status --short` 不含 `src/`、`desktop/` | — | `git status --short` 原始输出 |
| 8 | `external_browser_submit` 审批门未被触碰：本包未调用任何提交/审批自动动作 | — | 副作用清单注明 no |

---

## 9. 必跑命令

```powershell
# 环境侦察
& "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" --version
& "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" -e "try{require.resolve('playwright');console.log('playwright: yes')}catch(e){console.log('playwright: no')}"
npx --no-install playwright --version
Get-Process | Where-Object{$_.Name -match 'chrom|electron|haha|cc'} | Select-Object Name,Id,MainWindowTitle
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object{$_.LocalPort -in @(9222,9229,9333)} | Select-Object LocalPort,OwningProcess

# CDP version（若 9222 已暴露）
Invoke-RestMethod http://127.0.0.1:9222/json/version

# 探针脚本（存于 $env:TEMP\p0_cdp_probe.mjs，仓库外，纯 Node 零依赖）
#   const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
#   const ws = new WebSocket(v.webSocketDebuggerUrl);
#   ws.onopen = () => ws.send(JSON.stringify({id:1, method:'Target.getTargets'}));
#   ws.onmessage = (e) => { console.log(e.data); ws.close(); };
```

期望：环境侦察给出 Playwright 可用性与 cc-haha/CDP 现状；`/json/version` 返回含 `webSocketDebuggerUrl` 的 JSON。

---

## 10. 必须产出的报告

路径：`docs/recon/P0_CDP_RECON_2026-10-03.md`，使用如下模板（逐节填写，附原始输出）：

```
# P0 CDP 取证证据包（Route A: connectOverCDP）

## 1. 环境与工具
  - Node 版本 / Playwright 可用性 / cc-haha 版本与路径 / CDP 端口
## 2. CDP 连接稳定性
  - attach 成功/断开/重连记录、延迟、次数
## 3. 目标识别
  - targets 列表、ChatGPT Web 识别方式、与 app 自身窗口区分
## 4. 登录态确认
  - 判定信号 + 结论（已登录/未登录/不确定）
## 5. 页面 / DOM 结构
  - 关键 selector、无障碍树节点、消息容器结构
## 6. 消息读取方式
  - selector / 无障碍路径 / 取回文本样例（含代码块逐字节比对）
## 7. 消息发送方式
  - 输入框定位、输入事件方式、发送动作、是否触发风控
## 8. 响应完成检测方式
  - 停止动画/pending 标记/轮询策略、≥20 次采样误判记录
## 9. 失败与超时
  - 每次失败/超时的原始现象 + 原因
## 10. 对 P0-01~05 的逐条结论与证据
## 11. 对 M4 设计的启示（仅事实，不做设计决定）
```

---

## 11. 回滚方式

- 删除 `$env:TEMP\p0_cdp_probe.mjs`（仓库外，本就未提交）
- 若判定 `BLOCKED` 或无长期价值，可删除 `docs/recon/P0_CDP_RECON_2026-10-03.md`
- 本包**无任何 Git 改动需回滚**（见 §6）

---

## 12. 执行记录（截至 2026-10-03，仅记录，未实现 P0-09~11）

证据包：`docs/recon/P0_CDP_RECON_2026-10-03.md`（已更新至 P0-08）。

**已验证事实**：CDP attach（P0-01 PASS）；Runtime.evaluate；Assistant DOM / message boundary / message-id；ProseMirror 输入框定位与文本注入（P0-01~P0-07 链路）。

**P0-08 实测结果（关键修订）**：
- `button[type="submit"][aria-label="发送"]` 复检 `count=0 / enabledCount=0` → 发送按钮稳定 selector **不成立**（早期一次扫描的 PASS 结论已被推翻）。
- Composer 内部仅 4 个 button（添加文件/思考/听写/开始语音），其中 `bg-composer-primary` 出现在「开始语音」按钮上 → 该 class 亦非发送标识。
- DOM `dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}))` 被页面 `preventDefault`（`defaultPrevented=true`、`dispatcher=false`、assistantCount 4→4 无变化）→ **发送方案 discard**。

**未验证**：稳定发送通道、真实发送、发送后新 Assistant reply 提取、streaming 完成检测（P0-09~11 待研究，按用户指令不实现）。

**下一步研究计划（仅记录）**：P0-09 `Input.dispatchKeyEvent` 研究 → P0-10 单次真实发送 → P0-11 新回复提取 + streaming 完成检测。
