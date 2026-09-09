# 多 Agent 启用

EasyGithub 流水线支持三种编码 Agent，它们共用同一个密钥与验证/重试流程，区别仅在于 CLI 与 DeepSeek 接入方式：

| Agent  | 引擎                     | DeepSeek 接入方式                                    | 默认模型                                        |
| ------ | ------------------------ | ---------------------------------------------------- | ----------------------------------------------- |
| `pi`   | Pi coding agent（默认）  | 原生 DeepSeek API                                    | `deepseek-v4-pro`（可用仓库变量 `AI_MODEL` 改） |
| `claude` | Claude Code CLI        | Anthropic 兼容端点 `https://api.deepseek.com/anthropic` | `deepseek-v4-pro[1m]`（`ANTHROPIC_MODEL`）    |
| `codex` | Codex CLI                | DeepSeek Responses 端点（`wire_api = "responses"`）  | 由 `~/.codex/config.toml` 决定（可 `CODEX_MODEL` 覆盖） |

## 选择优先级

一个 Issue 最终使用哪个 Agent，按以下顺序决定（高到低）：

1. Issue 标签 `agent:<name>`（单 Issue 覆盖）
2. 仓库变量 `AI_AGENT`（强制所有运行）
3. `agent-runner/config/agents.json` 中的路由规则（如 `refactor` 标签 → `claude`）
4. 默认 `pi`

### 用标签指定引擎

给 Issue 同时打上 `ai` 与 `agent:<name>` 标签即可，例如 `agent:claude`、`agent:codex`、`agent:pi`：

```bash
gh label create "agent:claude" -R <owner/repo>
gh issue edit 15 --add-label "ai,agent:claude"
```

`bash scripts/create-labels.sh <owner/repo>` 会一并创建三个 `agent:<name>` 标签。

### 仓库变量 AI_AGENT

在 *Settings → Secrets and variables → Actions → Variables* 中设置 `AI_AGENT=claude`（或 `pi` / `codex`），
则所有运行都使用该引擎，忽略标签与路由规则。留空表示自动路由。

其它可选变量：`AI_MODEL`（Pi 模型，默认 `deepseek-v4-pro`）、`AI_THINKING`、`AI_MAX_ATTEMPTS`（默认 `3`，验证失败重试次数）、`VERIFY_CMD`（覆盖自动探测的检查命令）。

## 所需密钥

三种 Agent 只需要 **一个**仓库 Secret：

```text
DEEPSEEK_API_KEY   # DeepSeek 平台 API Key，三个 Agent 共用
```

- `pi`：直接使用 `DEEPSEEK_API_KEY`（原生 DeepSeek 支持，无需兼容层）。
- `claude`：工作流自动将其填入 `ANTHROPIC_AUTH_TOKEN`，并设置 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`。
- `codex`：初始化时由 Runner 自动写入 `~/.codex/config.toml`（provider `deepseek`）。

无需单独的 Anthropic / OpenAI Key。

## CI 自动安装

- `pi`：工作流（`.github/workflows/ai-agent.yml`）中固定版本安装
  （`@earendil-works/pi-coding-agent@0.85.1`）。
- `claude` / `codex`：Runner 在 CI 中按需自动安装（见 `agent-runner/src/cli.ts` 的 `ensureAgentCli`）：
  - `claude` → `npm install -g @anthropic-ai/claude-code`
  - `codex` → `npm install -g @openai/codex`，再运行 DeepSeek 一键配置脚本，用 `DEEPSEEK_API_KEY` 写入 `~/.codex/config.toml`

三者都复用同一套独立验证与重试循环（`AI_MAX_ATTEMPTS`），验证通过后才提交并创建 PR。

## 本地运行

`bash scripts/dev-run.sh <owner/repo> <issue-number>` 固定使用 `AGENT=pi`。非 Pi Agent 的
自动安装/配置仅在 CI 中执行，本地运行 `claude` / `codex` 需手动安装并配置对应 CLI。
