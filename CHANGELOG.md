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
