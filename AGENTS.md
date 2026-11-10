# EasyGithub — repository guide for agents

EasyGithub is an AI software-development pipeline: a GitHub Issue tagged `ai` is picked up by a GitHub Actions job that runs an AI coding agent (Pi) in a dedicated branch and opens a pull request.

## Layout

- `agent-runner/` — TypeScript runner. No runtime dependencies; uses Node built-ins plus the `gh`, `git`, and `pi`/`claude`/`codex` CLIs. Run with Node >= 22.19 (native type stripping). Entry point: `agent-runner/src/main.ts`; cross-repo dispatcher: `agent-runner/src/dispatcher.ts`. Guardrails: `src/verify.ts` (frozen gate), `src/policy.ts` (path/secret audit), `src/risk.ts` (risk tiers + auto-merge), `src/profile.ts` (per-repo profile), `src/env.ts` (agent env allow-list). Support tools: `src/eval.ts` (frozen tasks), `src/retro.ts` (weekly report), `src/watch.ts` (cross-repo post-merge watchdog), `src/metrics.ts`, `src/learnings.ts`.
- `agent-runner/prompts/` — task templates rendered by the runner (bug-fix / feature / review).
- `agent-runner/config/agents.json` — agent routing rules.
- `agent-runner/config/repos.json` — per-repository profile (verify commands, protected/blocked paths, dependency manifests, learnings file, default agent/model); see `docs/portability.md`. Legacy `config/verify.json` and the `EASYGH_VERIFY_CMDS` variable still override it.
- `eval/tasks/` — frozen evaluation tasks (repo + commit + issue + hidden tests) used by `src/eval.ts`.
- `docs/learnings.md` — curated context injected into `TASK.md` (top matching sections).
- `.github/workflows/ai-agent.yml` — the pipeline workflow (self-host).
- `.github/workflows/ai-agent-reusable.yml` + `.github/actions/agent-runner` — reusable cross-repo mode (mode 2).
- `.github/workflows/ghapp-scan.yml` + `scripts/ghapp-token.mjs` — GitHub-App zero-file mode (mode 3); `ai-run.yml` — one task on a profile-selected runner (self-hosted macOS/Windows).
- `scripts/` — helper scripts (`dev-run.sh`, `create-labels.sh`, `install-to-repo.sh`).
- `docs/` — `ai-workflow.md` (end-to-end workflow, risk tiers, human touchpoints), `portability.md` (adapting the pipeline to other projects), `agents.md` (multi-agent + model config), `realtime.md` (event-driven vs polling), `other-orgs.md` (using EasyGithub in other organizations; `ghapp-scan` org is `vars.EASYGH_ORG`).

## Checks

- Type check: `npm run typecheck` (root, runs the workspace).
- Tests: `npm test` (root; `node --test` in `agent-runner/test/`). `npm run check` = typecheck + tests.
- Workflow lint: `.github/workflows/ci.yml` runs [actionlint](https://github.com/rhysd/actionlint)
  (pinned version) on every PR — catches YAML/semantics errors in `*.yml` (an unquoted `: ` in a
  step name once disabled `ghapp-scan`'s triggers, so keep this green).
- The pipeline independently verifies agent output with `npm run check` before opening a PR
  (`AI_MAX_ATTEMPTS` controls retries). The check command and script body are frozen *before*
  the agent runs; if the agent edits `package.json`/`Cargo.toml` etc. the frozen version is
  executed instead and the PR gets `ai-verify-changed`.
- Staged changes are audited before commit (`src/policy.ts`): `.github/workflows/**`,
  `.github/actions/**` and `LICENSE` are rejected; `agent-runner/**`, `.github/**` and
  `scripts/**` are allowed but labelled `ai-core` for human review; added lines are scanned
  for credential material.
- The agent never inherits `GH_TOKEN`/`GITHUB_TOKEN`/`EASYGH_PR_TOKEN` (`src/env.ts`), and git
  push credentials are stripped from the worktree while it runs (`src/git.ts`).
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

`ai` (trigger), `ai-running`, `ai-pr`, `ai-failed`, `ai-done`, `ai-needs-input` (waiting for a human answer),
`ai-deferred` (quota/deadline; safe to retry), `ai-core` (touches the runner/CI/installers), `ai-verify-changed`
(check config edited mid-run), `ai-automerge` (auto-merge armed), `ai-incident` (AI merge broke main), `retro`.
Agent override: `agent:<name>` (pi/claude/codex).
