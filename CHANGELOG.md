# Changelog

本项目所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- Agent Runner 独立验证与失败自动重试：agent 完成后 runner 会独立运行仓库检查 `npm run check`，失败时把输出反馈给 agent 重试，最多 `AI_MAX_ATTEMPTS`=3 次。
- 变更审计 `agent-runner/src/policy.ts`：提交前做路径白名单（拒绝 `.github/workflows/**`、`.github/actions/**`、`LICENSE`；标记 `ai-core` 供人工审查）、剔除 vendored/生成目录、扫描新增行中的密钥。
- Agent 环境白名单 `agent-runner/src/env.ts`：子进程不再继承 `GH_TOKEN` / `GITHUB_TOKEN` / `EASYGH_PR_TOKEN`；git push 凭据在 agent 阶段从工作树移除（内存暂存，推送前恢复）。
- 原子认领锁 `ai-lock-issue-<n>`（Git Data tag ref CAS），支持按 TTL 回收僵尸运行；`finally` 中统一释放锁与更新标签。
- 时间预算 `AGENT_BUDGET_MS` / `PI_TIMEOUT_MS` / `VERIFY_TIMEOUT_MS` / `DISPATCH_BUDGET_MS`，超预算时给出明确失败评论而不是被 job timeout 砍断。
- `review` 任务类型落地：只读，输出 Review 报告作为 Issue 评论，不再产生空改动流水线。
- 新标签：`ai-core`、`ai-verify-changed`。

### Added (automation / minimal human intervention)

- 风险分级 `agent-runner/src/risk.ts`：low/medium/high 三档 + 自动合并谓词；high 风险一律**草稿 PR**。
- 自动合并 `AI_AUTOMERGE=off|probation|on`：仅 low 风险 + 可信验证时 `gh pr merge --auto`；probation 只信任 docs/测试改动。
- 结构化阻塞：agent 写 `EASYGH_BLOCKED.md` 即触发 `ai-needs-input`，评论提问并停止，不建 PR。
- 每日配额 `AI_MAX_PRS_PER_DAY`（默认 10），超限标记 `ai-deferred`。
- 人工命令入口 `.github/workflows/ai-decide.yml`：retry / cancel / answer / waive / set-automerge，带权限校验与 `easygh-decision` 审计。
- 合并后看护 `.github/workflows/ai-watch.yml`：main CI 红且来自 AI 合并 → 事故 Issue + 自动 revert PR + 熔断（`AI_AUTOMERGE=off`）；检测 24h 内的人工 revert。
- 周度复盘 `.github/workflows/ai-retro.yml` + `agent-runner/src/retro.ts`：失败签名聚类并开 `retro` Issue（不带 `ai`，由人决定是否执行）。
- 评测 `agent-runner/src/eval.ts` + `eval/tasks/`：冻结任务 + **隐藏测试**（agent 结束才落盘），输出 pass@1。
- 经验注入 `docs/learnings.md` → `TASK.md`（按相关性取 2 段，有长度上限）。
- 运行指标 `metrics.json`（产物 + 单行 JSON 日志）。
- 测试套件 `agent-runner/test/`（37 个用例，`npm run check` 现在包含测试）。
- `.github/CODEOWNERS`：`.github/**`、`agent-runner/**`、`scripts/**`、`eval/**`、`LICENSE` 必须 code owner 审查。
- 新标签：`ai-needs-input`、`ai-deferred`、`ai-automerge`、`ai-incident`、`retro`。

### Added (cross-repo automation)

- 跨仓库看护 `agent-runner/src/watch.ts`：dispatcher 每 5 分钟巡检 App 安装范围内的仓库——若默认分支 head 是 AI 合并且该提交上的 `push` 运行失败，自动开 `ai-incident` + 准备 revert PR。定时/安全扫描（`schedule`）不会误报。
- 熔断闭锁：`ai-incident` 打开期间该仓库不再自动合并（关闭 Issue 即恢复），`hasOpenIncident()` 在 arm auto-merge 前检查。
- 周报覆盖多仓库：`retro.ts --repos a/b,c/d` / `EASYGH_RETRO_REPOS`，按仓库分区统计。
- 开关：`EASYGH_WATCHDOG`（默认 on）。
- 多组织 `EASYGH_ORGS`（逗号分隔）：`ghapp-scan` 按组织做 matrix，每个组织独立签发 installation token。
- `ai-decide` 新增 `repo` 输入：hub 可直接 retry/cancel/answer 目标组织的 Issue（App token 执行）。
- 看护在读不到 workflow runs（App 缺 `Actions: read`）时显式 `skipped`，不再静默报健康。
- hub 的 `ai-watch` 改为调用同一个 `watch.ts`（新增 CLI 与 `--dry-run`），与目标仓库共用一套判定逻辑。

### Added (repository permissions)

- `scripts/enable-ai-gate.sh`：给"已有分支保护"的仓库统一配置必需检查 + 0 批准 + admin 应急绕过；
  已有 ruleset 管检查的仓库不重复叠加，`gh api` 的错误 JSON 不会被当成检查名。
- 文档补充权限模型：组织默认 `read` + 维护者 `write`，并记录"auto-merge 不认 bypass actor"的实测结论。

### Added (portability)

- 仓库画像 `agent-runner/src/profile.ts` + `config/repos.json`：按仓库配置验证命令、受保护/禁止/敏感/忽略路径、
  依赖清单、经验文件、默认 agent/model、重试与配额；默认行为不变（不配置就走自动探测）。
- 自动探测新增 Swift（`Package.swift`）、Gradle（`gradlew`）、Maven（`pom.xml`）、Elixir（`mix.exs`）。
- 新增 `docs/portability.md`：通用化手册、字段与优先级、验证命令的运行环境约束、新项目接入清单。
- OrzMCApp（Swift）画像落地：Ubuntu 可跑的 `check-platform-split.sh` + Swift 目录的受保护路径 + 经验文件指向 `docs/iteration-flow.md`。

### Added (verifyContainer)

- 仓库画像支持 `verifyContainer`：验证命令在指定 Docker 镜像内执行（Swift / .NET / 特定 JDK 等
  宿主没有的工具链），工作区挂载到 `/work`；容器模式下不在宿主预装依赖；Docker 不可用时明确失败。
- 验证闸门同时冻结 `verifyContainer` 与命令引用脚本的内容哈希。

### Added (runsOn)

- 仓库画像支持 `runsOn`（字符串或 label 数组）：App 模式下，dispatcher 不再在 hub 上直接执行，而是
  `workflow_dispatch` `ai-run.yml` 到指定 label 的 runner（自托管 macOS/Windows 可用）。
- `ai-run.yml`：在目标 runner 上签发目标组织的 installation token、克隆目标仓库、运行标准 runner。
- `ghapp-scan` 增加 `actions: write`（仅用于 dispatch；App token 无法 dispatch hub 工作流）。
- 无匹配 runner 时任务保持排队（不静默回退 ubuntu），文档给出取消/补 runner 的指引。

### Added (self-healing branches)

- 推送前 `git fetch` 基线 + rebase：基线在运行期间前进时不再产出 `DIRTY` PR；rebase 变了就重新验证。
- 推送被拒（竞态）自动 rebase 并重试一次；推送改用 `--force-with-lease`（只覆盖自己的分支）。
- 真冲突：abort rebase、列出冲突文件、Issue 打 `ai-needs-input`（`retry` 可在最新基线上重做）。
- `ai-watch` 自愈：对 `DIRTY`/`BEHIND` 的 `ai/issue-*` 分支自动 "Update branch"，真冲突才交给人。
- 测试：`test/git.test.ts`（真实 bare remote：无变化 / rebase / 冲突 abort / fetch 失败 / force-push）、
  `test/watch.test.ts`（只挑 `ai/issue-<n>` 且过期/冲突的 PR）。

### Added (docs)

- `docs/usage.md`：使用手册（三种运行方式、怎么写 Issue、状态机、风险分级、五种人工动作、配置速查、故障排查、安全边界）。
- `README.md` 增加"从这里开始"入口，测试数量与目录结构更新。

### Added (workflow guard)

- `test/env-forwarding.test.ts`：workflow 必须转发每一个 hub 配置变量，并反向检查变量表不腐烂。
  顺带修掉两处真实缺口：`EASYGH_PROVIDER`（三个 workflow 全缺）、`AI_MAX_ATTEMPTS`（`ghapp-scan` 缺）。
- `prompts/strict/`：示例变体（强制测试、禁新依赖、禁改公共 API），文档说明如何按项目定制。

### Added (prompt i18n)

- `AI_LOCALE`（环境/仓库变量）+ 画像 `locale`：渲染对应语言的 `TASK.md`，未知语言回退英文。
- 画像 `promptsDir` / `EASYGH_PROMPTS_DIR`：按仓库定制模板变体（`prompts/<dir>/<kind>.md` 优先）。
- 解析顺序：变体+语言 → 变体+默认 → 共享+语言 → 共享+默认；非法 locale/目录（含 `..`）直接丢弃。
- 内置简体中文模板 `agent-runner/prompts/zh-cn/`，`prompts/README.md` 说明规则。
- 测试：locale/目录规范化、回退链、中英 token 集合一致性、渲染替换（79 个用例）。

### Added (provider seam)

- `agent-runner/src/providers/`：平台抽象层（`types.ts` 接口 + capabilities、`github.ts` 唯一实现、`index.ts` 注册表）。
- `main.ts` 所有平台调用改为走 `resolveProvider()`；`EASYGH_PROVIDER` 选择实现，未实现的平台会明确报错，不静默回退。
- 抽象范围：Issue/标签/评论/PR/auto-merge/认领锁/事故闭锁；GitHub 专属能力（App 发现、workflow dispatch、rulesets）通过 capabilities 标记。
- 测试：注册表、默认值、环境变量、未实现平台报错、自定义 provider 可注册（63 个用例）。

### Changed

- 检查命令在 agent 运行前冻结；若检查配置被改动，执行冻结版本并标记 `ai-verify-changed`，不再把"跳过验证"当作"验证通过"。
- App 轮询模式：`easygh-ai` 标记仅接受 OWNER/MEMBER/COLLABORATOR 作者，防止外部驱动注入。
- 移除 workflow 中无效的 "Skip already-handled issues" 步骤（步骤内 `exit 0` 并不会跳过后续步骤），去重统一由 runner 负责。

### Verified

- `claude` 与 `codex` 两个 agent 已使用 DeepSeek 同一把 key 完成端到端验收（2026-09-09）。

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
