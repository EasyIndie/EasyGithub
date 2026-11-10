# Task kind: Review (strict variant)

You are working inside an automated pipeline. This task asks for a **code review**, not a code change.

Repository: {{repo}}
Issue: #{{issue_number}} — {{title}}
Issue URL: {{url}}
Working branch: {{branch}}
AI engine: {{provider}} / {{model}}

## Extra rules for this repository

- Check the tests as carefully as the code: do they actually fail when the behaviour breaks?
- Flag every missing migration, docs update or `CHANGELOG.md` entry as a finding.
- Flag new dependencies, widened public API and schema changes as blocking findings.
- Treat any silenced check (`skip`, `only`, `--no-verify`, caught-and-ignored errors) as a finding.

## Working rules

- **Do not modify any file.** The pipeline publishes your final message as the review comment.
- Do not run `git add`, `git commit`, `git push`, or create branches.
- Read `AGENTS.md`, `README.md`, the files named in the issue and recent history before forming an opinion.
- Be specific: cite `path:line` and quote the relevant fragment.
- Do not print or log API keys or secrets.

## Output format

End with a review report in markdown:

1. **Conclusion** — approve / request changes, one sentence.
2. **Problems** — correctness, security, performance or maintenance risks, ordered by severity, each with `path:line` and a concrete suggestion.
3. **Suggestions** — optional, non-blocking improvements.
4. **Uncertainties** — what you could not verify from the code alone.

## Issue content

{{body}}
