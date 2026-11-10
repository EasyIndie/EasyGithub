# Changelog

本项目所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

**护栏（runner 侧执行，prompt 只是提示）**

- 独立验证与失败自动重试：agent 结束后 runner 自己跑仓库检查，失败把输出反馈给 agent 重试（`AI_MAX_ATTEMPTS`，默认 3）。
- 变更审计 `src/policy.ts`：路径白名单（拒绝 `.github/workflows/**`、`.github/actions/**`、`LICENSE`）、剔除 vendored/生成目录、扫描新增行的密钥；`agent-runner/**`、`.github/**`、`scripts/**` 打 `ai-core` 供人工审查。
- 环境白名单 `src/env.ts`：agent 子进程拿不到 `GH_TOKEN` / `GITHUB_TOKEN` / `EASYGH_PR_TOKEN`；`git` 推送凭据在 agent 阶段从工作树移除（内存暂存，推送前恢复）。
- 原子认领锁 `ai-lock-issue-<n>`（tag ref CAS，按 TTL 回收僵尸锁）。
- 时间预算 `AGENT_BUDGET_MS` / `PI_TIMEOUT_MS` / `VERIFY_TIMEOUT_MS` / `DISPATCH_BUDGET_MS`。
- `.github/CODEOWNERS`：`.github/**`、`agent-runner/**`、`scripts/**`、`eval/**`、`LICENSE` 必须 code owner 审查。

**自动化（最小人工介入）**

- 风险分级 `src/risk.ts`：low / medium / high + 自动合并谓词；high 一律草稿 PR。
- `AI_AUTOMERGE=off|probation|on`：仅 low 风险且验证可信时 `gh pr merge --auto`；probation 只信任仅文档/测试的改动。
- 结构化阻塞：agent 写 `EASYGH_BLOCKED.md` → `ai-needs-input`，评论提问并停止，不建 PR。
- 每日配额 `AI_MAX_PRS_PER_DAY`（默认 10），超限标 `ai-deferred`。
- 人工入口 `.github/workflows/ai-decide.yml`：retry / cancel / answer / waive / set-automerge，带权限校验与 `easygh-decision` 审计。
- 合并后看护 `.github/workflows/ai-watch.yml` + `src/watch.ts`：main CI 红且由 AI 合并且该提交 `push` 失败 → 事故 Issue + revert PR + 熔断（`AI_AUTOMERGE=off`）；读不到 workflow runs 时显式 `skipped`。定时/安全扫描不误报。
- 周度复盘 `ai-retro.yml` + `src/retro.ts`：失败签名聚类开 `retro` Issue（不带 `ai`，由人决定是否执行）；`EASYGH_RETRO_REPOS` 支持多仓库。
- 评测 `src/eval.ts` + `eval/tasks/`：冻结任务 + 隐藏测试，输出 pass@1。
- 经验注入：`docs/learnings.md`（或画像 `learningsFile`）按相关性取 2 段注入 `TASK.md`。
- 运行指标 `metrics.json`（artifact + 单行 JSON 日志）。

**通用化（适配任意项目）**

- 仓库画像 `src/profile.ts` + `config/repos.json`：验证命令、受保护/禁止/敏感/忽略路径、依赖清单、经验文件、默认 agent/model、重试与配额。
- `verifyContainer`：验证在指定 Docker 镜像里跑（宿主没有的工具链），工作区挂到 `/work`；Docker 缺失时明确失败。
- `runsOn`：任务交给指定 label 的 runner（自托管 macOS/Windows），由 `ai-run.yml` 执行；无匹配 runner 时排队、不静默回退。
- 自动探测新增 Swift / Gradle / Maven / Elixir（原有 npm / cargo / go / pytest）。
- 提示词变体：`AI_LOCALE` + 画像 `locale` + `promptsDir`/`EASYGH_PROMPTS_DIR`，解析顺序「变体+语言 → 变体+默认 → 共享+语言 → 共享+默认」；内置 `prompts/zh-cn/`，示例变体 `prompts/strict/`。
- 平台抽象 `src/providers/`：Issue/标签/评论/PR/auto-merge/锁/事故闭锁统一接口 + capabilities；`EASYGH_PROVIDER` 选实现，未实现即报错。
- 分支自愈：推送前 rebase（基线动过则重新验证）、推送被拒自动重试、`--force-with-lease`；`ai-watch` 对 `DIRTY`/`BEHIND` 的 `ai/issue-*` 自动 "Update branch"。

**文档与测试**

- `docs/usage.md`（使用手册）、`docs/portability.md`（画像与接入）、`docs/other-orgs.md`（多组织）、`docs/ai-workflow.md`（端到端设计）。
- 测试套件 `agent-runner/test/`：93 个用例（`npm run check` = typecheck + 测试），含真实 bare remote 的 git 集成测试与 workflow env 转发守卫。
- `scripts/enable-ai-gate.sh`：给已有分支保护的仓库统一配置必需检查 + 0 批准 + admin 应急绕过；`scripts/ghapp-manifest.mjs` 创建组织自有 App；`scripts/install-to-repo.sh` 安装 Mode 1/2。

### Changed

- 检查命令在 agent 运行前冻结；检查配置被改动时执行冻结版本并标 `ai-verify-changed`，不再把"跳过验证"当作"验证通过"。
- App 轮询模式的 `easygh-ai` 标记仅接受 OWNER/MEMBER/COLLABORATOR 作者，防止外部驱动注入。
- 重新排队以**标签**为准（`ai` 在、`ai-pr`/`ai-failed` 等不在即为重跑），不再因为存在旧 PR 而跳过。
- 移除 workflow 中无效的 "Skip already-handled issues" 步骤（步骤内 `exit 0` 不会跳过后续步骤），去重统一由 runner 负责。

### Fixed

- `ai-decide retry` 之前无效：dispatcher 以"已有 open PR"为由跳过；现在重跑会删重名分支（旧 PR 随之关闭）、在最新基线上重做并开新 PR。
- 两个 AI PR 改同一文件后产生 `DIRTY` PR：改为推送前 rebase + 看门狗 "Update branch"；真冲突则 `ai-needs-input` 并列出文件。
- workflow `env:` 漏转发导致变量静默失效：`EASYGH_PROVIDER`（三个 workflow）、`AI_MAX_ATTEMPTS`（`ghapp-scan`）、`AI_LOCALE`（`ghapp-scan`）。
- 看门狗的自愈结果被 dispatcher 过滤（`action: none`）而不可见。

### Verified

- `claude` 与 `codex` 使用同一把 DeepSeek key 完成端到端验收（2026-09-09）。
- 真实链路：EasySticker（Node）、EasyBot（Rust）、OrzMCApp（Swift，画像 + 中文模板）Issue → PR → 零点击合并。
- `runsOn` 交接链：`ghapp-scan` → `ai-run.yml` → 目标 runner，实测 Issue #168 → PR #169 自动合并。

## [0.2.0] - 2026-09-09

### Added

- 多 Agent 支持：`pi`、`claude`、`codex` 统一注册在 `CodingAgent` 接口后。
- Agent 路由：新增 `agent-runner/config/agents.json` 路由规则，Issue 标签 `agent:<name>` 可覆盖选择。

## [0.1.1] - 2026-09-09

### Changed

- `ai-agent` 工作流的 GitHub Actions 升级到 v7（`actions/checkout`、`actions/setup-node`、`actions/upload-artifact`），消除 Node 20 弃用告警。

### Added

- 新增 `.github/workflows/ci.yml`：pull request 自动运行 `npm run check` 类型检查。

## [0.1.0] - 2026-09-09

EasyGithub V0.1 里程碑：AI 软件开发流水线正式上线（Issue → GitHub Actions → Agent Runner → Pi → PR）。

### Added

- `ai` 标签驱动的自动化流水线：GitHub Issue 打上 `ai` 标签后，自动在独立分支上运行 AI 编码代理，并提交、推送、创建 PR。
- Agent Runner（TypeScript，零运行时依赖）：负责认领 Issue、渲染 TASK.md、创建分支、编排 git 与 PR。
- AI 代理抽象层 `CodingAgent`，当前注册 `pi`（DeepSeek `deepseek-v4-pro`），为后续接入多代理预留接口。
- 任务模板：bug-fix / feature / review。
- 根级 `npm run check` / `npm run typecheck` 一键类型检查脚本。
- 辅助脚本：`scripts/dev-run.sh`（本地干跑，无需 Actions 分钟）、`scripts/create-labels.sh`（初始化流水线标签）。

### Verified

- 已在 EasyGithub 本仓库上自托管验证 Issue → PR 完整闭环。
