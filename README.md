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

`agent-runner/src/agents/types.ts` defines `CodingAgent`; `registry.ts` currently registers only
`pi`, which is the seam for future agents (Claude Code, Codex, OpenClaw/EasyTeam, …).

## Requirements / costs

- GitHub Actions minutes (free tier or paid) — the job runs a full Pi session, typically several minutes.
- One provider API key stored as a repo secret: `DEEPSEEK_API_KEY` (DeepSeek V4; see below).
  Repository variables (optional): `AI_MODEL` (default `deepseek-v4-pro`), `AI_THINKING`,
  `AI_MAX_ATTEMPTS` (default `3`, verification retries), `VERIFY_CMD` (override the check
  command; default: auto-detect `check`/`verify`/`test`/`lint` in `package.json`).
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
- **V0.2 (partial):** independent verification + failure auto-retry inside the runner: after the
  agent finishes, the runner runs the repository's own checks (`npm run check`, or `VERIFY_CMD`)
  without trusting the agent; on failure the output is fed back to the agent for another attempt
  (default 3, `AI_MAX_ATTEMPTS`). This is the core of the future “CI failure → AI fixes” loop,
  implemented in-workflow to dodge the approval gate GitHub applies to bot-created PRs.
- **V0.2 (next):** more agents (Claude Code / Codex / EasyTeam `dev` team), agent routing, reuse
  across repos (requires a PAT or GitHub App; `GITHUB_TOKEN` cannot push to other repositories).
- **V0.3/V0.4:** PR-CI failure feedback for human PRs (`ci.yml` already runs `npm run check` on
  every PR); GitHub App webhooks, queue/task store, long-running server.

## License

Proprietary / all rights reserved for now. Revisit before making the repository public.
