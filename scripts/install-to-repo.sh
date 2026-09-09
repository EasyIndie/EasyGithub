#!/usr/bin/env bash
# Install the EasyGithub AI pipeline into another repository.
#
# The pipeline is self-contained per repository (GITHUB_TOKEN cannot cross
# repos), so this script copies the workflow + agent-runner into the target
# repo as a branch + PR, and prepares labels + the DEEPSEEK_API_KEY secret.
#
# Usage:
#   bash scripts/install-to-repo.sh <owner/repo> [--with-ci] [--no-secret]
#     --with-ci    also copy .github/workflows/ci.yml (only if none exists there)
#     --no-secret  skip setting the DEEPSEEK_API_KEY secret (e.g. already set)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
WITH_CI=0
NO_SECRET=0
for a in "${@:2}"; do
  case "$a" in
    --with-ci) WITH_CI=1 ;;
    --no-secret) NO_SECRET=1 ;;
    *) echo "unknown option: $a" >&2; exit 1 ;;
  esac
done
if [ -z "$TARGET" ]; then echo "usage: $0 <owner/repo> [--with-ci] [--no-secret]" >&2; exit 1; fi

BRANCH="easygithub/ai-pipeline"
COMMIT_NAME="EasyGithub Installer"
COMMIT_EMAIL="easygithub[bot]@users.noreply.github.com"

# sanity -------------------------------------------------------------------
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated" >&2; exit 1; }
if ! gh repo view "$TARGET" >/dev/null 2>&1; then echo "repo not found: $TARGET" >&2; exit 1; fi
if [ "$TARGET" = "EasyIndie/EasyGithub" ]; then echo "refusing to install into EasyGithub itself (it already runs the pipeline)" >&2; exit 1; fi
DEFAULT_BRANCH="$(gh repo view "$TARGET" --json defaultBranchRef --jq '.defaultBranchRef.name')"
echo "==> target=$TARGET default=$DEFAULT_BRANCH"

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
if gh pr list --repo "$TARGET" --head "$BRANCH" --state open --json number --jq '.[0].number' | grep -qE '^[0-9]+$'; then
  OLD_PR="$(gh pr list --repo "$TARGET" --head "$BRANCH" --state open --json number --jq '.[0].number')"
  echo "==> replacing existing install PR #$OLD_PR"
  gh pr close "$OLD_PR" --repo "$TARGET" --comment "superseded by refreshed install" >/dev/null
fi
git push origin --delete "$BRANCH" 2>/dev/null || true

# overlay files ---------------------------------------------------------------
rm -rf agent-runner
cp -R "$ROOT/agent-runner" ./agent-runner
rm -rf agent-runner/node_modules agent-runner/*.tsbuildinfo
mkdir -p .github/workflows
cp "$ROOT/.github/workflows/ai-agent.yml" .github/workflows/ai-agent.yml
if [ "$WITH_CI" -eq 1 ] && [ ! -f .github/workflows/ci.yml ]; then
  cp "$ROOT/.github/workflows/ci.yml" .github/workflows/ci.yml
fi

git checkout -qb "$BRANCH"
git add -A
git -c user.name="$COMMIT_NAME" -c user.email="$COMMIT_EMAIL" \
  commit -m "chore: install EasyGithub AI pipeline (ai-agent workflow + agent-runner)" --quiet
git push -q -u origin "$BRANCH"

PR_BODY="## EasyGithub AI 流水线安装

为本仓库安装 **Issue → GitHub Actions → Agent Runner → AI(pi/claude/codex) → PR** 流水线：

- \`.github/workflows/ai-agent.yml\` — 触发：Issue 打上 \`ai\` 标签
- \`agent-runner/\` — 调度器（自动路由 agent、独立验证 \`AI_MAX_ATTEMPTS\`、自动开 PR）

### 使用

1. 本 PR 合并后，给 Issue 打 \`ai\` 标签即触发（可选 \`feature\`/\`bug\` 决定模板，\`agent:claude\` 等指定引擎）。
2. 若分支/PR 更新：在 EasyGithub 仓库运行 \`bash scripts/install-to-repo.sh $TARGET\` 会刷新本安装。
3. Secret \`DEEPSEEK_API_KEY\` 与 \`ai*\` 标签已由安装器配好（失败则手动配）。

> 说明：此方案为**每仓库自包含**（GITHUB_TOKEN 不能跨仓库写）。\`ci.yml\` 未包含，除非用 \`--with-ci\`。
"
gh pr create --repo "$TARGET" --base "$DEFAULT_BRANCH" --head "$BRANCH" \
  --title "chore: install EasyGithub AI pipeline" --body "$PR_BODY"
echo "==> done. Merge the PR in $TARGET to activate the pipeline."
