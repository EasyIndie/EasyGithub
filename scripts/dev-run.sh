#!/usr/bin/env bash
# Local dry-run of the agent pipeline against a real issue (no GitHub Actions).
# Usage: bash scripts/dev-run.sh <owner/repo> <issue-number> [model] [thinking]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${1:-}"
ISSUE="${2:-}"
MODEL="${3:-deepseek-v4-pro}"
THINKING="${4:-}"

if [ -z "$ISSUE" ]; then
  echo "usage: $0 <owner/repo> <issue-number> [model] [thinking]" >&2
  exit 1
fi

TMP_DIR="$ROOT/.tmp/dev-issue-$ISSUE"
RUN_TMP="$ROOT/.tmp/runner-issue-$ISSUE"
rm -rf "$TMP_DIR" "$RUN_TMP"
mkdir -p "$TMP_DIR" "$RUN_TMP"

gh auth setup-git >/dev/null 2>&1 || true
git clone --quiet "https://github.com/$REPO.git" "$TMP_DIR"
cd "$TMP_DIR"

DEFAULT_BRANCH="$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name')"

export GITHUB_REPOSITORY="$REPO"
export ISSUE_NUMBER="$ISSUE"
export AGENT=pi
export PROVIDER=deepseek
export MODEL="$MODEL"
export THINKING="$THINKING"
export DEFAULT_BRANCH="$DEFAULT_BRANCH"
export RUNNER_TEMP="$RUN_TMP"
export GH_TOKEN="$(gh auth token)"
export WORK_DIR="$TMP_DIR"

echo "==> dev-run repo=$REPO issue=#$ISSUE model=$MODEL branch-dir=$TMP_DIR"
node "$ROOT/agent-runner/src/main.ts"
