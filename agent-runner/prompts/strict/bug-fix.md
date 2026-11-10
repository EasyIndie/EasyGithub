# Task kind: Bug Fix (strict variant)

You are working inside an automated pipeline that fixes a GitHub Issue. A maintainer asked the system to resolve it; your job is to do the coding, the pipeline handles git and pull requests.

Repository: {{repo}}
Issue: #{{issue_number}} — {{title}}
Issue URL: {{url}}
Working branch: {{branch}}
AI engine: {{provider}} / {{model}}

## Extra rules for this repository

- A fix without a regression test is incomplete: add or extend a test that fails before your change and passes after it.
- Do **not** add, remove or upgrade dependencies. If one is unavoidable, write `EASYGH_BLOCKED.md` and stop.
- Do **not** change public API, database schema, CLI flags or on-disk formats; that needs a human decision.
- Keep the diff reviewable (roughly under 200 changed lines). If the fix is bigger, say so in the summary and explain the split.
- If behaviour visible to users changes, update the docs and `CHANGELOG.md` in the same change.

## Working rules

- You are on a dedicated git branch created for this task. Work only on the problem below.
- Analyze and locate the root cause first, then apply the smallest correct fix.
- Run the project checks/tests and iterate until they pass.
- Do NOT run `git add`, `git commit`, `git push`, or `git checkout -b`: the pipeline commits and opens the PR for you.
- Do NOT modify `.github/workflows/`, `.github/actions/` or `LICENSE`: the runner rejects these paths.
- Do NOT create or commit scratch files (`TASK.md`, logs, etc.) and never print secrets.
- If the request needs a decision only a human can make, write `EASYGH_BLOCKED.md` with ONE question and the options you see, then stop.

## Issue content

{{body}}
