# EasyGithub

> AI software development pipeline on GitHub: **Issue → GitHub Actions → Agent Runner → Pi → PR**.

When an Issue gets the `ai` label, a GitHub Actions job spins up a fresh machine, checks out the
repository, runs an AI coding agent (Pi) on a dedicated branch, and opens a pull request.

> 本仓库是这套流水线的**实现本体（hub）**。要在你自己的仓库里让 AI 修 Issue，
> 见下方「在自己的仓库启用」；想给本仓库自己交 AI 任务，直接用文末/下方 `ai` 标签流程。

## How it works (V0.1)

```text
GitHub Issue #123 ──label: ai──▶ GitHub Actions (ubuntu, Node 24)
                                        │  npm i -g pi (pinned)
                                        ▼
                              Agent Runner (TypeScript)
                                        │  1. claim issue (ai-running)
                                        │  2. fetch issue → render TASK.md
                                        │  3. branch ai/issue-123
                                        ▼
                              Pi (deepseek-v4-flash, thinking=high, --mode json)
                                        │  analyze → edit → run checks → iterate
                                        │  (agent CLI installed on demand at runtime)
                                        ▼
                              commit → push → PR ("Fixes #123")
                                        │
                                        ▼
                              comment + labels (ai-pr / ai-failed / ai-done)
```

### Roles (kept deliberately separated)

| Piece          | Responsibility                              |
| -------------- | ------------------------------------------- |
| GitHub         | Issues / branches / PRs / CI results        |
| GitHub Actions | throwaway execution machine                 |
| Agent Runner   | scheduling + git + PR orchestration         |
| Pi             | the only "thinking" part (can be swapped)   |

`agent-runner/src/agents/types.ts` defines `CodingAgent`; `registry.ts` currently registers
`pi`, `claude`, and `codex` behind the same interface — the seam for swapping AI engines.
Routing: issue label `agent:<name>` > repo variable `AI_AGENT` > rules in
`agent-runner/config/agents.json` > default `pi`.

## Requirements / costs

- GitHub Actions minutes (free tier or paid) — the job runs a full Pi session, typically several minutes.
- One provider API key stored as a repo secret: `DEEPSEEK_API_KEY` (DeepSeek V4; see below).
  Repository variables (optional): `AI_MODEL` (default `deepseek-v4-flash`), `AI_THINKING` (default `high`),
  `AI_MAX_ATTEMPTS` (default `3`, verification retries), `VERIFY_CMD` (override the check
  command; default: auto-detect `check`/`verify`/`test`/`lint` in `package.json`),
  `AI_AGENT` (force a specific agent for every run; default: auto-route).
  On EasyGithub itself (public repo) all of this is already configured; other repos need the
  installer (`install-to-repo.sh`) or the App to set it up.

### Model / provider

Pi has native DeepSeek support, so the key is a plain DeepSeek platform key — **no Anthropic
compatibility layer needed**:

- default: `deepseek-v4-flash` + thinking `high` (cheap policy default)
- stronger: `deepseek-v4-pro`
- available via `vars.AI_MODEL`, or per-run via workflow env.

## 在本仓库试用（dogfood）

1. Make sure labels exist: `bash scripts/create-labels.sh EasyIndie/EasyGithub`
2. Open an Issue describing a bug or feature.
3. Add the `ai` label (optionally `feature` label / keyword to pick the template).
4. Watch `.github/workflows/ai-agent.yml` run; the bot comments progress and opens a PR.
5. Review and merge the PR (the branch/PR is auto-closed/replaced on re-run).

### Retrying after a failure

Remove the `ai-failed` label, then add `ai` again. Removing `ai-failed` is what re-arms the issue.

### PR CI

Every pull request (including AI pipeline PRs) runs `npm run check` via `.github/workflows/ci.yml`.

## 在自己的仓库启用（cross-repo reuse）

先选适合你的方式（按侵入性从低到高）：

- **组织内（EasyIndie）成员**：GitHub App 已全组织安装 → 用 **Mode 3**（零文件）。
- **外部/个人仓库**：仓库里不能只写注释就让 App 工作 → 用 **Mode 2**（推荐，1 个文件）或 **Mode 1**。
  （也可以自建同名 GitHub App 后获得 Mode 3，见 `docs/realtime.md`。）

**Mode 3 — GitHub App (zero-file; EasyIndie org only).** A GitHub App
(`easygithub-ai`, installed org-wide) lets the hub poll org Issues and write
branches/PRs in any installed repo. Targets contain **no workflow, no runner,
no secret**. Mark an Issue for AI by adding the `ai` label or putting
`easygh-ai` anywhere in its title/body. Polling runs every 5 minutes (EasyGithub is public, so these runs are free/unmetered)
(`.github/workflows/ghapp-scan.yml` → `agent-runner/src/dispatcher.ts`);
secrets live only in the hub.

**Mode 2 — caller file (low-intrusion, works anywhere).** One ~15-line workflow in the target
calls the centralized reusable workflow + composite action in EasyGithub. Needs: admin on target
(to let the installer set the `DEEPSEEK_API_KEY` secret + labels) and EasyGithub must be readable
(public now, so any repo can use it).

**Mode 1 — full copy (works anywhere).** `--copy` overlays the whole pipeline (workflow +
`agent-runner/`) into the target; fully self-contained, no dependency on EasyGithub.

```bash
bash scripts/install-to-repo.sh EasyIndie/<repo>    # mode 2 caller
bash scripts/install-to-repo.sh EasyIndie/<repo> --copy   # mode 1
```

### 30 秒快速上手（按模式）

**Mode 3（零文件 · EasyIndie 成员）** — 什么都不用装：
```bash
# 1) 在任意 EasyIndie 仓库开一个 Issue，标题/正文含 easygh-ai，或打上 ai 标签
gh issue create -R EasyIndie/<repo> --title "fix: xxx" --body "...\n\n<!-- easygh-ai -->"
# 2) 等 ≤5 分钟，hub 轮询发现后自动开 PR（标签/secret 都不需要你管）
```

**Mode 2（1 个文件 · 任何仓库）** — 安装一次即可用：
```bash
# 0) 前置：gh 已登录、对目标仓库有 admin、有 DeepSeek key（或准备手动设 secret）
gh repo clone EasyIndie/EasyGithub ~/easygh
# 1) 自动：建 caller workflow + 标签 + 开 PR（若能读到本地 DeepSeek key 则一并设 secret）
bash ~/easygh/scripts/install-to-repo.sh <you>/<repo>
#    若提示跳过 secret：手动补一次 gh secret set DEEPSEEK_API_KEY -R <you>/<repo>（值从 platform.deepseek.com 获取）
# 2) 合并安装 PR（gh pr list 找到编号后）
gh pr merge <PR#> -R <you>/<repo>
# 3) 用起来：给任意 Issue 打 ai 标签
gh issue edit <N> -R <you>/<repo> --add-label ai
```

**Mode 1（全复制 · 任何仓库，需离线自包含）** — 同 Mode 2，仅安装命令加 `--copy`：
```bash
bash ~/easygh/scripts/install-to-repo.sh <you>/<repo> --copy
# 之后同上：合并安装 PR → 打 ai 标签触发
```

> 三种模式都支持：标签 `feature`/`bug` 选模板、`agent:claude`/`agent:codex` 选引擎；
> 验证失败自动重试（`AI_MAX_ATTEMPTS`），通过后才开 PR。更多见 [docs/agents.md](docs/agents.md)。

Known platform limitation (verified): a reusable workflow invoked cross-repo
cannot declare a `permissions` key (fails at queue time); write access comes
from the caller job permissions + repo default=write. GitHub App installation
tokens also cannot use the Search API or `gh --paginate` (dispatcher lists
repos/issues directly).

### Local dry run (no Actions minutes)

```bash
bash scripts/dev-run.sh EasyIndie/EasyGithub <issue-number> [model] [thinking]
```

Runs the exact same runner code locally (clone → branch → Pi → commit → push → PR).

## Repository layout

```text
.github/workflows/ai-agent.yml   # the pipeline
agent-runner/                    # Agent Runner (TypeScript, zero runtime deps)
  prompts/                       # task templates (bug-fix / feature / review)
  src/main.ts                    # orchestration
  src/git.ts, src/github.ts      # git + gh wrappers
  src/agents/{types,pi,registry}.ts
scripts/                         # dev-run.sh, create-labels.sh
```

Run `npm run check` (one-shot equivalent of `npm run typecheck`) before committing. There is no test suite yet.

## 参考文档

- [多 Agent 启用与模型配置](docs/agents.md)
- [实时响应方案（事件驱动 vs 轮询）](docs/realtime.md)

## Status & roadmap

- **V0.1 (done):** single-repo, Pi/DeepSeek, Issue→PR. Verified on this repository (self-hosting).
- **V0.2 (done):** multi-agent seam. `registry.ts` registers `pi`, `claude` (Claude Code CLI) and
  `codex` (Codex CLI) behind the same `CodingAgent` interface. Agent selection precedence:
  1. issue label `agent:<name>` (per-issue), 2. repo variable `AI_AGENT` (forces all runs),
  3. rules in `agent-runner/config/agents.json`, 4. default `pi`. Activated with the same
  verification/retry loop. Pi is E2E-verified; claude/codex adapters need their CLIs + keys in the
  Actions environment (`claude` + `ANTHROPIC_API_KEY`/`CLAUDE_MODEL`, `codex` + `OPENAI_API_KEY`/`CODEX_MODEL`).
- **V0.3/V0.4:** PR-CI failure feedback for human PRs (`ci.yml` already runs `npm run check` on
  every PR); GitHub App webhooks, queue/task store, long-running server.

## License

**Business Source License 1.1** (BUSL-1.1) — see [`LICENSE`](LICENSE).

- 源码公开可见；**非生产用途、组织内部使用（含用本流水线开发你自己的项目）免费**。
- **禁止**将 EasyGithub 本身（或衍生版）作为托管/付费服务提供给第三方（*AI Pipeline Service*）——此类使用需取得商业授权。
- Change Date `2030-09-09`；到期后自动转为 **Apache License 2.0**。
- 商业授权 / 合作咨询：在 [Issues](https://github.com/EasyIndie/EasyGithub/issues) 留言或联系 EasyIndie 组织所有者。
- **贡献条款**：目前**未开放外部代码贡献**（BUSL 下需先签署 CLA 才能合并外部 PR，以保证将来仍可调整协议/双许可）。欢迎以 Issue 形式反馈。
