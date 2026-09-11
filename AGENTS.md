# EasyGithub — repository guide for agents

EasyGithub is an AI software-development pipeline: a GitHub Issue tagged `ai` is picked up by a GitHub Actions job that runs an AI coding agent (Pi) in a dedicated branch and opens a pull request.

## Layout

- `agent-runner/` — TypeScript runner. No runtime dependencies; uses Node built-ins plus the `gh`, `git`, and `pi`/`claude`/`codex` CLIs. Run with Node >= 22.19 (native type stripping). Entry point: `agent-runner/src/main.ts`; cross-repo dispatcher: `agent-runner/src/dispatcher.ts`.
- `agent-runner/prompts/` — task templates rendered by the runner (bug-fix / feature / review).
- `agent-runner/config/agents.json` — agent routing rules.
- `.github/workflows/ai-agent.yml` — the pipeline workflow (self-host).
- `.github/workflows/ai-agent-reusable.yml` + `.github/actions/agent-runner` — reusable cross-repo mode (mode 2).
- `.github/workflows/ghapp-scan.yml` + `scripts/ghapp-token.mjs` — GitHub-App zero-file mode (mode 3).
- `scripts/` — helper scripts (`dev-run.sh`, `create-labels.sh`, `install-to-repo.sh`).

## Checks

- Type check: `npm run typecheck` (root, runs the workspace).
- The pipeline independently verifies agent output with `npm run check` before opening a PR
  (`AI_MAX_ATTEMPTS` controls retries).
- There is no automated test suite yet.

## Working in this repo

- Keep `agent-runner` free of runtime dependencies: Node built-ins only, plus the `gh` / `git` / `pi` CLIs.
- Never print or log API keys (`DEEPSEEK_API_KEY` and friends). GitHub masks secrets in logs, but do not rely on it.
- Never commit local run logs, `.tmp/`, or `TASK.md`.
- Changes to `.github/workflows/ai-agent.yml` or pipeline semantics are deliberate: this pipeline runs itself, so avoid accidental recursion.
- Pipeline branches and PRs use the `ai/issue-<n>` naming scheme.

## License

Business Source License 1.1 (see `LICENSE`). External contributions are not
accepted yet (a CLA is required first). Keep the BUSL parameters intact when
editing `LICENSE` (Licensor: EasyIndie, Change Date: 2030-09-09, Change
License: Apache-2.0).

## Labels used by the pipeline

`ai` (trigger), `ai-running`, `ai-pr`, `ai-failed`, `ai-done`. Agent override: `agent:<name>` (pi/claude/codex).
