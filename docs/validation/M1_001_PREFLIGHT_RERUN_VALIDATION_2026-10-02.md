# M1-001 — CodeBuddy Preflight Re-run & Repository Layout Repair

Project: WorkbenchOS
Validation ID: M1-001-PREFLIGHT-02
Validation Type: Repository & Toolchain Preflight + Structural Repair
Execution Date: 2026-10-02
Executed By: CodeBuddy
Execution Mode: Read-only diagnosis → authorized structural repair + backups
Final Decision: **PASS**

---

## 1. Summary

上一次预检（`M1_001_CODEBUDDY_PREFLIGHT_VALIDATION_2026-09-22.md`）结论为 `BLOCKED`，两个阻塞项：

1. Bun 在执行环境中不可用
2. Git 只读命令被 dubious-ownership 校验阻断

本轮在 D: 盘新位置重跑，两个阻塞项均已解除。

同时发现并修复了一个未被记录的 **P1 级结构问题**：工作树与 HEAD 整体错位——整个被跟踪树（4840 个文件）
已从仓库根物理移入 `WorkbenchOS/` 子目录，但从未提交，导致 `git status` 显示 4840 条删除 + 1 条未跟踪目录。

若此时执行 `git add -A` 并提交，将把与上游永久错位的路径结构写入历史，直接违反 `D-002`（上游友好 fork）。

已通过**移动 `.git` 元数据目录**完成修复，未触碰任何工作文件，三判据全部通过。

---

## 2. Execution Identity

- Actual agent: CodeBuddy
- Actual model / SKU: `UNKNOWN` —— 当前运行环境未暴露可验证标识，不作声称
- Reasoning strength telemetry: `UNKNOWN`

---

## 3. Repository

| 项目 | 值 |
|---|---|
| Repository path（修复后即仓库根） | `D:\WorkbenchOS\WorkbenchOS` |
| 工作区容器 | `D:\WorkbenchOS` |
| origin | `https://github.com/OliCheung/cc-haha.git` |
| upstream | `https://github.com/NanmiCoder/cc-haha.git` |
| branch | `main` |
| HEAD | `b8c7a115` |

位置变更说明：M0 全部 artifact 记录的路径为 `M:\vibecoding\Projects\WorkbenchOS`。该盘已删除，
D: 为当前及长期工作位置。因此 M0 artifact 中的 `file:///M:/...` 链接已全部失效（见 §9）。

---

## 4. 发现的结构问题（修复前状态）

修复前：仓库根 = `D:\WorkbenchOS`，项目整体位于其下的 `WorkbenchOS\`。

| 指标 | 修复前 |
|---|---|
| `git rev-parse --show-toplevel` | `D:/WorkbenchOS` |
| `package.json` @ 仓库根 | `TRACKED` |
| `WorkbenchOS/package.json` | `NOT tracked` |
| `git status --short` 行数 | **4841** |
| 状态分布 | `4840 × D`（删除）+ `1 × ??`（`WorkbenchOS/` 被折叠为单条） |

诊断结论：HEAD 树位于仓库根，而磁盘上对应文件已全部移入 `WorkbenchOS/`。
git 视角 = 根目录全部删除 + 一棵全新的未跟踪子树。

### 4.1 修复前的安全性前置验证

在移动前验证了「`WorkbenchOS/` 是否为完整 HEAD 树」这一决定性问题：

```text
tracked total: 4840
missing under WorkbenchOS/: 0
```

4840 个被跟踪文件在 `WorkbenchOS/` 下**一个不缺**，因此移动 `.git` 不会把任何丢失静默化。

另确认 `D:\WorkbenchOS\docs` 为**空目录**（递归文件数 0），无内容需要抢救。

---

## 5. 修复操作

### 5.1 备份（全部位于仓库之外）

| 备份对象 | 路径 |
|---|---|
| git 元数据（含完整历史） | `D:\WorkbenchOS-backup-20261002\git\.git` |
| 治理文档（未跟踪，不可再生） | `D:\WorkbenchOS-backup-20261002\governance\` |
| 修复前状态快照 | `D:\WorkbenchOS-backup-20261002\status-before.txt`（4841 行） |
| 修复后状态快照 | `D:\WorkbenchOS-backup-20261002\status-after.txt`（7 行） |

治理文档备份清单：`docs_audits`、`docs_decisions`、`docs_design`、`docs_reviews`、`docs_validation`、
`state`、`AGENTS.md`、`WORKBENCHOS_PROJECT_RULES.md`。

移动前执行了备份完整性闸门（`.git\HEAD` / `config` / `objects` 存在性校验），不通过则中止。

### 5.2 唯一改动

```powershell
Move-Item 'D:\WorkbenchOS\.git' 'D:\WorkbenchOS\WorkbenchOS\.git'
```

该操作**只移动 git 元数据目录，不触碰任何工作文件**，且完全可逆。

---

## 6. 验证结果（三判据）

| 判据 | 期望 | 实际 | 结果 |
|---|---|---|---|
| 仓库根 | `D:/WorkbenchOS/WorkbenchOS` | `D:/WorkbenchOS/WorkbenchOS` | PASS |
| 状态行数 | 显著下降 | **4841 → 7** | PASS |
| 内容 | 仅 `??`，无 `D` | `7 × ??`，零 `D` | PASS |

修复后完整状态：

```text
## main...origin/main
?? WORKBENCHOS_PROJECT_RULES.md
?? docs/audits/
?? docs/decisions/
?? docs/design/
?? docs/reviews/
?? docs/validation/
?? state/
```

与 M0 基线记录的 `?? docs/audits/` + `?? docs/reviews/` 形态一致；新增项为 M0 之后建立的治理文档。

### 6.1 附加验证

| 项 | 结果 |
|---|---|
| `git remote -v` | origin / upstream 均完好 |
| `main...origin/main` | `0 / 0` |
| `main...upstream/main` | `0 / 0` |
| `git diff --stat` | 空 |
| `git diff --cached --stat` | 空 |
| `git diff --check` | 空 |
| `docs/decisions/DECISION_LOG.md` | 存在 |
| `state/CURRENT_STATUS.md` | 存在 |
| `WORKBENCHOS_PROJECT_RULES.md` | 存在 |
| 外层布局 | `D:\WorkbenchOS` 现仅含 `docs`（空，仓库外）与 `WorkbenchOS`（仓库） |

**目标结构达成**：`D:\WorkbenchOS\docs` 现在是仓库的兄弟目录，位于仓库之外。

---

## 7. 工具链验证

| 工具 | 结果 | 对比上次预检 |
|---|---|---|
| `bun --version` | **1.4.2** | 上次 `UNAVAILABLE` → 已解除 |
| `node --version` | **v24.19.0** | 与上次一致 |
| `git` 只读命令 | 全部可执行 | 上次被 dubious-ownership 阻断 → 已解除 |

### 7.1 未完成项

```text
node_modules: False
desktop/node_modules: False
```

依赖尚未安装。`D-015` 要求「No M1-001 implementation can be accepted without executing the relevant
Bun tests」，因此在执行 M1-001 前必须先 `bun install`。本轮未执行安装（不在任务范围内）。

---

## 8. D-015 门禁核对

| D-015 要求 | 结果 |
|---|---|
| `bun --version` | PASS（1.4.2） |
| `node --version` | PASS（v24.19.0） |
| `git status -sb` | PASS（仅预期的未跟踪治理文档） |
| `git rev-parse --short HEAD` | PASS（`b8c7a115`，与 M0 基线一致） |
| `git rev-list --left-right --count main...upstream/main` | PASS（`0 / 0`） |

**Final Decision: PASS**（预检门禁通过）

M1-001 执行前的前置条件：`bun install`，以及依赖安装后再确认测试可运行。

---

## 9. 遗留事项

1. **治理文档位置决策（未决）**
   `WORKBENCHOS_PROJECT_RULES.md` §3 声明治理文档位于项目内部，现状亦然；而本次修复的意图是将其置于仓库之外。
   两者目前并存且互相矛盾。需在以下三选一中做出明确决定，并据此更新 §3：
   - 选项 1：留在项目内（接受其进入 fork 提交）
   - 选项 2：移出仓库（`D:\WorkbenchOS\docs`）
   - 选项 3：单独建仓库（可追溯且脱离 cc-haha 提交流）

2. **`D-018` 版本化冲突**
   M: 盘已删除、D: 盘为唯一副本。治理文档当前不受版本控制，与「artifact 是权威来源」的要求存在冲突。
   决策 1 中应一并考虑版本化或快照机制。

3. **M0 artifact 死链**
   M0 artifact 中的 `file:///M:/vibecoding/Projects/WorkbenchOS/...` 链接已全部失效，
   后续文档卫生时统一迁移到 D: 路径。

4. **VSCode 需重新加载窗口**才能识别新的仓库根。

5. **备份保留策略**
   `D:\WorkbenchOS-backup-20261002` 建议保留至 M1-001 首次提交完成之后。

---

## 10. 副作用与边界

- Changed files（被跟踪）：**none**（`git diff` / `git diff --cached` 均为空）
- New files：本报告（未跟踪，符合现有治理文档状态）
- Git config 修改：**no**
- Commit：**no**
- Push：**no**
- Branch 创建/切换：**no**
- Merge / rebase / reset / clean：**no**
- 依赖安装：**no**
- 凭据 / cookie / token / 浏览器 profile 访问：**no**
- 真实 provider / model 请求：**no**

---

## 11. 验证证据

已执行命令（全部只读，除 §5.2 的 `Move-Item`）：

`git rev-parse --show-toplevel` · `git rev-parse --short HEAD` · `git rev-parse --abbrev-ref HEAD` ·
`git remote -v` · `git status --short` · `git status -sb` · `git ls-files` ·
`git ls-files --error-unmatch` · `git rev-list --left-right --count` · `git diff --stat` ·
`git diff --cached --stat` · `git diff --check` · `bun --version` · `node --version` ·
`Get-ChildItem` / `Test-Path` 文件系统核对

原始输出快照：

- `D:\WorkbenchOS-backup-20261002\status-before.txt`（4841 行）
- `D:\WorkbenchOS-backup-20261002\status-after.txt`（7 行）
