#!/usr/bin/env bash
# Install the EasyGithub AI pipeline into another repository.
#
# Default mode (recommended): LOW-INTRUSION — writes a single ~15-line caller
# workflow that calls the centralized reusable workflow + composite action in
# EasyIndie/EasyGithub (runner code stays there; @main auto-updates).
#
# Legacy mode: `--copy` overlays the full workflow + agent-runner into the
# target repo (self-contained per repo; no dependency on EasyGithub).
#
# In both modes the installer also creates labels and sets the
# DEEPSEEK_API_KEY secret, then opens a PR for review.
#
# Usage:
#   bash scripts/install-to-repo.sh <owner/repo> [--copy] [--ref <tag|branch>] [--with-ci] [--no-secret]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
MODE="call"
REF="main"
WITH_CI=0
NO_SECRET=0
rest="${*:2}"
for a in $rest; do
  case "$a" in
    --copy) MODE="copy" ;;
    --with-ci) WITH_CI=1 ;;
    --no-secret) NO_SECRET=1 ;;
    --ref) : ;; # value comes next
    --ref=*) REF="${a#--ref=}" ;;
    -*) : ;; # tolerate unknown flags loosely (ref value consumed below)
  esac
done
# crude --ref <value> parsing
if [ -n "${2:-}" ] && [ "${2:-}" = "--ref" ]; then REF="${3:-main}"; fi
if [ -z "$TARGET" ]; then echo "usage: $0 <owner/repo> [--copy] [--ref tag|branch] [--with-ci] [--no-secret]" >&2; exit 1; fi

BRANCH="easygithub/ai-pipeline"
COMMIT_NAME="EasyGithub Installer"
COMMIT_EMAIL="easygithub[bot]@users.noreply.github.com"
HUB="EasyIndie/EasyGithub"

# sanity -------------------------------------------------------------------
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated" >&2; exit 1; }
if ! gh repo view "$TARGET" >/dev/null 2>&1; then echo "repo not found: $TARGET" >&2; exit 1; fi
if [ "$TARGET" = "$HUB" ]; then echo "refusing to install into $HUB (it already runs the pipeline)" >&2; exit 1; fi
DEFAULT_BRANCH="$(gh repo view "$TARGET" --json defaultBranchRef --jq '.defaultBranchRef.name')"
echo "==> target=$TARGET default=$DEFAULT_BRANCH mode=$MODE ref=$REF"

# labels (independent of the PR) -------------------------------------------
echo "==> labels"
bash "$ROOT/scripts/create-labels.sh" "$TARGET"

# secret -------------------------------------------------------------------
if [ "$NO_SECRET" -eq 0 ]; then
  KEY="$(node -e "const a=require(process.env.HOME+'/.pi/agent/auth.json');process.stdout.write((a.deepseek&&a.deepseek.key)||'')")"
  if [ -n "$KEY" ]; then
    if gh secret set DEEPSEEK_API_KEY --repo "$TARGET" --body "$KEY" 2>/dev/null; then
      echo "==> secret DEEPSEEK_API_KEY set on $TARGET"
    else
      echo "!! could not set secret (need admin on $TARGET); set it manually: Settings > Secrets and variables > Actions" >&2
    fi
  else
    echo "!! no DeepSeek key found in ~/.pi/agent/auth.json; skipping secret" >&2
  fi
fi

# build the branch -----------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone --quiet "https://github.com/$TARGET.git" "$TMP/repo"
cd "$TMP/repo"

# close/replace an existing install branch/PR (refresh on updates)
OLD_PR="$(gh pr list --repo "$TARGET" --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || true)"
if [ -n "$OLD_PR" ] && [ "$OLD_PR" != "null" ]; then
  echo "==> replacing existing install PR #$OLD_PR"
  gh pr close "$OLD_PR" --repo "$TARGET" --comment "superseded by refreshed install" >/dev/null || true
fi
git push origin --delete "$BRANCH" 2>/dev/null || true

mkdir -p .github/workflows

if [ "$MODE" = "copy" ]; then
  # legacy: full self-contained copy
  rm -rf agent-runner
  cp -R "$ROOT/agent-runner" ./agent-runner
  rm -rf agent-runner/node_modules agent-runner/*.tsbuildinfo
  cp "$ROOT/.github/workflows/ai-agent.yml" .github/workflows/ai-agent.yml
else
  # low-intrusion caller: 15 lines pointing at the hub reusable workflow
  cat > .github/workflows/ai-agent.yml <<EOF
name: ai-agent

on:
  issues:
    types: [labeled]

concurrency:
  group: ai-agent-\${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  agent:
    if: github.event.label.name == 'ai'
    uses: $HUB/.github/workflows/ai-agent-reusable.yml@$REF
    with:
      issue-number: \${{ github.event.issue.number }}
      agent: \${{ vars.AI_AGENT || '' }}
      model: \${{ vars.AI_MODEL || '' }}
      thinking: \${{ vars.AI_THINKING || '' }}
      max-attempts: \${{ vars.AI_MAX_ATTEMPTS || 3 }}
      verify-cmd: \${{ vars.VERIFY_CMD || '' }}
    secrets:
      deepseek-api-key: \${{ secrets.DEEPSEEK_API_KEY }}
EOF
fi

if [ "$WITH_CI" -eq 1 ] && [ ! -f .github/workflows/ci.yml ]; then
  cp "$ROOT/.github/workflows/ci.yml" .github/workflows/ci.yml
fi

git checkout -qb "$BRANCH"
git add -A
git -c user.name="$COMMIT_NAME" -c user.email="$COMMIT_EMAIL" \
  commit -m "chore: install EasyGithub AI pipeline ($MODE mode)" --quiet
git push -q -u origin "$BRANCH"

if [ "$MODE" = "copy" ]; then
  MODE_NOTE="- \`.github/workflows/ai-agent.yml\` — full self-contained copy (trigger: Issue labeled \`ai\`)\n- \`agent-runner/\` — full runner copy in this repo"
else
  MODE_NOTE="- \`.github/workflows/ai-agent.yml\` — **caller file only** (~15 lines)\n- 实际流水线与 runner 逻辑集中在 \`$HUB\`（reusable workflow @\`$REF\`），runner 更新自动生效"
fi

PR_BODY="## EasyGithub AI 流水线安装（mode: $MODE）

为本仓库接入 **Issue → AI(pi/claude/codex) → 独立验证 → PR** 流水线。

$MODE_NOTE

### 使用

1. 合并本 PR 后，给 Issue 打 \`ai\` 标签即触发（可选 \`feature\`/\`bug\` 模板标签、\`agent:claude\` 引擎标签）。
2. Secret \`DEEPSEEK_API_KEY\` 与 \`ai*\`/\`agent:*\` 标签已由安装器配置。
3. 更新：重新运行安装器刷新（caller 模式自动跟随 \`@$REF\`，基本无需刷新）。

> 参考: \`$HUB\` 仓库 docs/agents.md
"
gh pr create --repo "$TARGET" --base "$DEFAULT_BRANCH" --head "$BRANCH" \
  --title "chore: install EasyGithub AI pipeline ($MODE)" --body "$PR_BODY"
echo "==> done. Merge the PR in $TARGET to activate the pipeline."
