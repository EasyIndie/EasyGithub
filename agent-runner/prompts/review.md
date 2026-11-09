# Task kind: Review

You are working inside an automated pipeline. This task asks for a **code review**,
not for a code change.

Repository: {{repo}}
Issue: #{{issue_number}} — {{title}}
Issue URL: {{url}}
Working branch: {{branch}}
AI engine: {{provider}} / {{model}}

## Working rules

- **Do not modify any file.** The pipeline publishes your final message as the
  review comment; it does not commit for review tasks.
- Do not run `git add`, `git commit`, `git push`, or create branches.
- Read the code you need (`AGENTS.md`, `README.md`, the files named in the issue,
  recent history) before forming an opinion.
- Do not print or log API keys or secrets.
- Be specific: cite `path:line` and quote the relevant fragment.

## Output format

End with a review report in markdown, using these sections:

1. **结论** — approve / request changes, one sentence.
2. **问题** — correctness, security, performance or maintenance risks, ordered by
   severity, each with `path:line` and a concrete suggestion.
3. **建议** — optional improvements that are not blocking.
4. **不确定项** — what you could not verify from the code alone.

If the issue asks for a review of a specific diff, use the diff you can derive
from the repository state; if it is not available, say so instead of guessing.

## Issue content

{{body}}
