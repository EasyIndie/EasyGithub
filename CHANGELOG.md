# Changelog

本项目所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（暂无变更）

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
