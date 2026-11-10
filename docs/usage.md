# 使用手册（How to use EasyGithub）

这份文档是**操作手册**：怎么提任务、怎么读结果、出问题怎么处理。
想了解内部机制看 [`ai-workflow.md`](ai-workflow.md)，想接入新项目看 [`portability.md`](portability.md)。

---

## 1. 先选一种运行方式

| 方式 | 适合 | 需要什么 | 配置在哪 |
|---|---|---|---|
| **A. 自托管 hub** | 就用本仓库（EasyGithub 自身） | 本仓库的 secrets | 本仓库 `.github/workflows/ai-agent.yml` |
| **B. 复用 workflow** | 目标仓库可以放文件 | 目标仓库装一个 caller workflow | 目标仓库 `.github/workflows/*.yml` |
| **C. 零文件 App 模式** | 目标仓库**不放任何文件** | 一个 GitHub App 装到组织 | hub 的 `ghapp-scan.yml` + `config/repos.json` |

方式 B 的安装脚本：`scripts/install-to-repo.sh`；方式 C 的 App 创建/安装见 [`other-orgs.md`](other-orgs.md)。

三种方式**契约一致**（标签、状态、PR 结构都一样），只是"谁触发、在哪台机器跑"不同。

---

## 2. 发起一个任务

### 2.1 写 Issue

在目标仓库开一个 Issue，然后给它打上 `ai` 标签。**标签就是开关**，没有别的命令要敲。

一个好的 Issue 长这样：

```md
## 需要做的事

在 `docs/README.md` 末尾追加一节「常见问题」，列出构建失败时先看的两个脚本。

## 约束

- 只改 `docs/README.md`。
- 不要动代码和测试。
```

判据：

| 要写清 | 为什么 |
|---|---|
| **验收标准** | agent 不知道"做好"的边界，就会过度发挥 |
| **范围**（哪些文件/不要动什么） | 直接决定 diff 大小与风险等级 |
| **复现步骤**（缺陷类） | 没有复现，agent 只能猜根因 |
| **不要问 agent 做决定**（产品取舍、凭据、外部系统） | 这类问题它会写 `EASYGH_BLOCKED.md` 停下来 |

可选：`feature` 标签 → 用功能实现模板；`review` 标签 → 只读评审（只发评论，不开 PR）；
`agent:claude` / `agent:codex` → 临时换 AI 引擎。

### 2.2 触发时机

- 打上 `ai` 标签后，最长约 5 分钟被扫到（零文件模式）/ 立即触发（方式 A、B）。
- 同一 Issue 只会有一个运行：认领锁 `ai-lock-issue-N` 保证不重复消费。
- 想立刻重跑：见 §5 的 `retry`。

---

## 3. 等待期间发生了什么

```text
Issue #123 [ai]
   │
   ├─ ai-running        已认领，正在跑（锁 TTL 到期会自动释放）
   │
   ├─ ai-pr             已推送分支 + 开 PR
   ├─ ai-needs-input    agent 说"需要人决定"，问题已发在 Issue 里
   ├─ ai-deferred       配额/预算用尽，安全可重试
   ├─ ai-failed         失败（看评论里的日志尾部）
   └─ ai-done           完成但无可提交改动 / 评审任务已发评论
```

期间 agent 会在分支上：定位问题 → 改代码 → **自己跑检查** → 迭代。它看不到任何 token，
也改不了 `.github/workflows/**`、`.github/actions/**`、`LICENSE`。

---

## 4. 读结果：PR 与风险分级

PR 结构固定：

```
[AI] fix: #123 简短标题
├─ Summary            agent 的自述（中文）
├─ Fixes #123
├─ 验证结果            独立验证跑的命令与结果（不是 agent 自述）
└─ 风险等级与理由
```

风险分级决定"要不要人看"：

| 等级 | 触发条件 | 结果 |
|---|---|---|
| **low** | 小 diff、验证通过、未碰受保护路径 | `AI_AUTOMERGE=on` 时**自动合并** |
| **medium** | 稍大改动 / 验证被跳过 / 依赖清单变更之外的可疑项 | 普通 PR，**需要人合并** |
| **high** | 改受保护路径（`.github/`、`agent-runner/`、`scripts/`）、依赖清单、>500 行、验证被篡改 | **草稿 PR**（物理上合并不了）+ `ai-core` 标签 |

关键点：**验证是在 agent 跑之前冻结的**。agent 改 `package.json`、改检查脚本都没用——
跑的还是冻结的那份，且 PR 会被打上 `ai-verify-changed`。

---

## 5. 人工介入：五种动作

所有动作都是 workflow_dispatch，会留下 `easygh-decision` 审计评论：

```bash
# 重跑（删分支 + 在最新基线上重来）——最常用
gh workflow run ai-decide.yml -R EasyIndie/EasyGithub \
  -f repo=OrzMC/OrzMCApp -f issue=168 -f action=retry

# 回答 agent 的问题（它停在了 EASYGH_BLOCKED.md）
gh workflow run ai-decide.yml -R EasyIndie/EasyGithub \
  -f repo=OrzMC/OrzMCApp -f issue=168 -f action=answer \
  -f note="用方案 B：只在 macOS 上跑，不要动 Linux 路径"

# 放弃正在跑的任务（释放认领锁）
gh workflow run ai-decide.yml -R EasyIndie/EasyGithub \
  -f repo=OrzMC/OrzMCApp -f issue=168 -f action=cancel

# 记录一次人工豁免（只写审计，不放宽策略）
... -f action=waive -f note="这次允许改 .github/，已人工复核"

# 切自动合并档位（off / probation / on）
... -f action=set-automerge -f mode=probation
```

| 动作 | 什么时候用 |
|---|---|
| `retry` | `ai-failed`、`ai-deferred`、分支冲突、想换基线上重来 |
| `answer` | `ai-needs-input`：agent 抛出的问题你已经有结论了 |
| `cancel` | 卡住/不想要了；同时释放锁，避免 `ai-running` 挂着 |
| `waive` | 需要留下"人已复核"的痕迹（不会绕过路径/密钥检查） |
| `set-automerge` | 事故后收窄自动化（`off`）或逐步放开（`probation` → `on`） |

`AI_AUTOMERGE` 语义：

- `off`：从不自动合并；
- `probation`：只自动合并**仅文档/测试**的 low 风险 PR；
- `on`：所有 low 风险 PR。

---

## 6. 配置速查（hub 仓库变量 / secrets）

| 变量 | 默认 | 作用 |
|---|---|---|
| `AI_AUTOMERGE` | `off` | `off` / `probation` / `on` |
| `AI_LOCALE` | 画像或 `en` | 提示词语言（`zh-cn` / `en` …） |
| `AI_MAX_ATTEMPTS` | `3` | agent 失败后重试次数（含验证反馈） |
| `AI_MAX_PRS_PER_DAY` | `10` | 每仓库每日 PR 上限，超了打 `ai-deferred` |
| `AI_AGENT` | 画像或规则 | 强制 agent（`pi` / `claude` / `codex`） |
| `AI_REVIEWER` | 空 | 把 AI PR 指派给某人 |
| `EASYGH_PROVIDER` | `github` | 平台实现（目前只有 `github`，写错会明确报错） |
| `EASYGH_PROMPTS_DIR` | 画像 | 提示词变体目录 |
| `EASYGH_MAX_ISSUES` | `4` | 一次扫描最多处理几个 Issue |
| `EASYGH_WATCHDOG` | `on` | 合并后健康检查/自愈 |
| `AGENT_BUDGET_MS` | `2400000` | 单个任务总预算（40 分钟） |
| `PI_TIMEOUT_MS` | `900000` | 单次 agent 会话上限（15 分钟） |
| `VERIFY_TIMEOUT_MS` | `600000` | 验证命令超时 |

Secrets：`DEEPSEEK_API_KEY`（模型）、`EASYGH_APP_PRIVATE_KEY[_<ORG>]`（App 模式）。
**千万不要**把 token 传给 agent —— runner 会主动剥离。

---

## 7. 让流水线适配你的项目

最小画像（`agent-runner/config/repos.json`）：

```json
{
  "repos": {
    "Acme/Api": {
      "verify": ["npm run check"],
      "protectedPaths": ["src/auth/"],
      "dependencyFiles": ["package.json", "package-lock.json"]
    },
    "Acme/iOS": {
      "runsOn": ["self-hosted", "macos", "xcode-26"],
      "verify": ["xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 17' test"],
      "locale": "en"
    }
  }
}
```

- `verify`：独立验证命令（不写则自动探测 npm/cargo/go/pytest/swift/gradle/maven）；
- `verifyContainer`：`"swift:6.0"` 之类，用 Docker 跑验证；
- `runsOn`：交给指定 runner（macOS/Windows 必须有它）；
- `protectedPaths`：命中即 high 风险（草稿 PR）；
- `learningsFile`：把项目经验注入提示词。

字段全表与优先级见 [`portability.md`](portability.md) §2。

---

## 8. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 一直 `ai-running` 不动 | 运行崩了没回收锁 | 锁有 TTL（默认 ~2h）自动释放；急用 `cancel` 再 `retry` |
| `ai-failed` + 验证输出 | 代码没通过检查 | 看评论里的命令与输出，改 Issue 说明后 `retry` |
| `ai-verify-changed` | agent 改了检查配置 | 冻结版本已执行；人工确认后再决定是否合并 |
| `ai-core` | 改到了 `.github/`、`agent-runner/`、`scripts/` | 必须人工 review（CODEOWNERS） |
| `ai-deferred` | 当日 PR 配额用尽 | 等配额恢复，或调 `AI_MAX_PRS_PER_DAY` 后 `retry` |
| `ai-needs-input` | agent 明确要人做决定 | 用 `answer` 回复，或直接 `retry` 并改 Issue |
| PR 一直 `BLOCKED` | 缺少必需检查 / 分支落后 | 现在会自动 rebase；仍不行看 §9 |
| 两个 AI PR 改同一文件 | 后者分支过期 | **已自愈**：看门狗会调 GitHub "Update branch" 重放；真冲突会提示 |
| 任务一直排队 | `runsOn` 没有匹配的 runner | 检查自托管 runner 的标签与在线状态 |
| 什么标签都没加 | 触发条件没满足 | 确认 Issue 上有 `ai` 标签（不是标题关键词） |
| `incident` 不自动合并 | 上次 AI 合并把 main 弄坏了 | 处理事故 Issue → 关闭 → 自动合并恢复 |

---

## 9. 分支冲突与"更新分支"

- **开 PR 前**：runner 会 `fetch` 基线并 rebase；若基线在你跑的过程中前进过，rebase 后会**重新验证**再推送。
- **推送被拒**（极小竞态）：自动 rebase 一次并重试。
- **开 PR 后**：`ai-watch` 会把 `DIRTY`/`BEHIND` 的 `ai/issue-*` 分支自动"Update branch"。
- **真冲突**（两边改同一行）：rebase 会 abort，Issue 打 `ai-needs-input` 并列出冲突文件 → `retry`（在最新基线上重做，通常冲突就没了）或人工解决。

---

## 10. 观测与成本

- **每次运行**：GitHub Actions 日志 + 上传的 artifact（`ai-issue-<n>/`：`TASK.md`、agent 日志、验证日志）。
- **指标**：`metrics.json`（每次运行一行 JSON：风险、验证、耗时、是否自动合并）。
- **日/周报**：`ai-retro` 生成周报（Issue），`docs/learnings.md` 每周可被提 PR 更新。
- **成本控制**：`AI_MAX_PRS_PER_DAY`、`AGENT_BUDGET_MS`、`PI_TIMEOUT_MS`、`EASYGH_MAX_ISSUES`。

---

## 11. 安全边界（为什么可以放心）

1. agent 进程**拿不到** `GH_TOKEN` / `GITHUB_TOKEN` / App token（`src/env.ts` 白名单）。
2. agent 运行期间 worktree 的 git 凭据被摘掉，推送前才在内存里恢复（`src/git.ts`）。
3. `.github/workflows/**`、`.github/actions/**`、`LICENSE` 提交即被拒（`src/policy.ts`）。
4. 检查命令与脚本内容在 agent 运行**之前**冻结（`src/verify.ts`），改配置无效。
5. 提交前扫描新增行里的密钥材料。
6. 高风险改动只能出**草稿 PR**，合并按钮是灰的。
7. 组织默认权限 `read`：外部人拿不到写权限，合并只能由维护者或 App 完成。

---

## 12. 日常操作清单

每周:

- [ ] 看 `ai-retro` 周报：失败原因、验证跳过率、自动合并占比
- [ ] 看有没有 `ai-incident` 未关（会一直闭锁自动合并）
- [ ] 清理长期挂着的 `ai-needs-input`

改动流水线本身时:

- [ ] 只走分支 → PR → 必需检查 → 合并（不要直推 main）
- [ ] `npm run check`（typecheck + 91 个测试）+ `actionlint`
- [ ] 改 `.github/workflows/**` 属于高风险，务必人工复核
