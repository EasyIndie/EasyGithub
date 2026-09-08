#!/usr/bin/env bash
# Create the pipeline labels on a repository.
# Usage: bash scripts/create-labels.sh [owner/repo]   (default EasyIndie/EasyGithub)
set -euo pipefail

REPO="${1:-EasyIndie/EasyGithub}"

declare -A COLORS=(
  [ai]="1F6FEB"
  [ai-running]="DB61A2"
  [ai-pr]="8250DF"
  [ai-failed]="B60205"
  [ai-done]="0E8A16"
)

create() {
  local name="$1" desc="$2"
  if gh label view "$name" -R "$REPO" >/dev/null 2>&1; then
    echo "label exists: $name"
  else
    gh label create "$name" -R "$REPO" --description "$desc" --color "${COLORS[$name]}"
    echo "label created: $name"
  fi
}

create ai "🤖 AI 处理请求（打上此标签触发流水线）"
create ai-running "⏳ AI 处理中"
create ai-pr "🔀 AI 已创建 PR"
create ai-failed "❌ AI 处理失败（移除后重打 ai 可重试）"
create ai-done "✅ AI 完成（无代码变更）"
echo "done: $REPO"
