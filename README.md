# EasyGithub

> AI software development pipeline on GitHub: **Issue → GitHub Actions → Agent Runner → Pi → PR**.

When an Issue gets the `ai` label, a GitHub Actions job spins up a fresh machine, checks out the
repository, runs an AI coding agent (Pi) on a dedicated branch, and opens a pull request.

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
                              Pi (deepseek-v4-pro, --mode json)
                                        │  analyze → edit → run checks → iterate
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
  Repository variables (optional): `AI_MODEL` (default `deepseek-v4-pro`), `AI_THINKING`,
  `AI_MAX_ATTEMPTS` (default `3`, verification retries), `VERIFY_CMD` (override the check
  command; default: auto-detect `check`/`verify`/`test`/`lint` in `package.json`),
  `AI_AGENT` (force a specific agent for every run; default: auto-route).
- Optional secret `EASYGH_PR_TOKEN`: a personal token used **only for PR creation**, needed when your
  org policy blocks the automatic GITHUB_TOKEN from creating pull requests
  (*Settings → Actions → General → “Allow GitHub Actions to create and approve pull requests”*).
  If that org toggle is enabled, the fallback is not needed.
  Repository variables (optional): `AI_MODEL` (default `deepseek-v4-pro`), `AI_THINKING`.

### Model / provider

Pi has native DeepSeek support, so the key is a plain DeepSeek platform key — **no Anthropic
compatibility layer needed**:

- default model: `deepseek-v4-pro` (strong reasoning)
- cheaper/faster: `deepseek-v4-flash`
- available via `vars.AI_MODEL`, or per-run via workflow env.

## Using the pipeline on this repo

1. Make sure labels exist: `bash scripts/create-labels.sh EasyIndie/EasyGithub`
2. Open an Issue describing a bug or feature.
3. Add the `ai` label (optionally `feature` label / keyword to pick the template).
4. Watch `.github/workflows/ai-agent.yml` run; the bot comments progress and opens a PR.
5. Review and merge the PR (the branch/PR is auto-closed/replaced on re-run).

### Retrying after a failure

Remove the `ai-failed` label, then add `ai` again. Removing `ai-failed` is what re-arms the issue.

### PR CI

Every pull request (including AI pipeline PRs) runs `npm run check` via `.github/workflows/ci.yml`.

### Deploy to another repository (cross-repo reuse)

`GITHUB_TOKEN` cannot write to other repositories, so the pipeline is **self-contained per repo**.
To install it into any repository (must be a repo where you have push + admin):

```bash
bash scripts/install-to-repo.sh EasyIndie/<repo>          # also copies ci.yml with --with-ci
```

The installer:

1. creates the `ai*` / `agent:*` labels on the target repo,
2. sets the `DEEPSEEK_API_KEY` secret (from your local `~/.pi/agent/auth.json`),
3. pushes a branch `easygithub/ai-pipeline` containing `.github/workflows/ai-agent.yml` +
   `agent-runner/` and opens a PR for you to review/merge.

After the PR is merged, tag an Issue with `ai` in that repo and the pipeline runs there
(optional `--with-ci` also copies the PR-CI workflow if the target has none; `--no-secret` skips the secret).
Re-run the installer any time to refresh the installed copy with the latest runner.

A future V0.4 (GitHub App) will replace copy-per-repo with a central hub + webhook dispatch.

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

Proprietary / all rights reserved for now. Revisit before making the repository public.
