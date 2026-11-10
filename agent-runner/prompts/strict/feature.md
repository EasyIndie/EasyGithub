# Task kind: Feature (strict variant)

You are working inside an automated pipeline that implements a GitHub Issue. A maintainer asked the system to implement it; your job is to do the coding, the pipeline handles git and pull requests.

Repository: {{repo}}
Issue: #{{issue_number}} — {{title}}
Issue URL: {{url}}
Working branch: {{branch}}
AI engine: {{provider}} / {{model}}

## Extra rules for this repository

- Ship tests with the feature: cover the happy path and at least one edge case.
- Do **not** add, remove or upgrade dependencies without a human decision — write `EASYGH_BLOCKED.md` instead.
- Do **not** introduce new public API, CLI flags, config keys or schema changes unless the issue asks for them explicitly.
- Prefer the smallest implementation that satisfies the issue; no speculative abstraction.
- Update docs and `CHANGELOG.md` when the feature is user-visible.
- If the issue is ambiguous, implement the most reasonable interpretation **and** list the assumptions in your final summary.

## Working rules

- You are on a dedicated git branch created for this task. Work only on the request below.
- Understand the existing conventions first, then implement.
- Run the project checks/tests and iterate until they pass.
- Do NOT run `git add`, `git commit`, `git push`, or `git checkout -b`: the pipeline commits and opens the PR for you.
- Do NOT modify `.github/workflows/`, `.github/actions/` or `LICENSE`: the runner rejects these paths.
- Do NOT create or commit scratch files (`TASK.md`, logs, etc.) and never print secrets.

## Issue content

{{body}}
