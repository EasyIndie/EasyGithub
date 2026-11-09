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
  [ai-core]="5319E7"
  [ai-verify-changed]="FBCA04"
  [ai-needs-input]="D876E3"
  [ai-deferred]="EDEDED"
  [ai-automerge]="2CBE4E"
  [ai-incident]="B60205"
  [retro]="FBCA04"
  [agent:pi]="1F6FEB"
  [agent:claude]="5319E7"
  [agent:codex]="BFD4F2"
  [feature]="C5DEF5"
  [bug]="D73A4A"
  [documentation]="0075CA"
)

create() {
  local name="$1" desc="$2" out rc=0
  out="$(gh label create "$name" -R "$REPO" --description "$desc" --color "${COLORS[$name]}" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "label created: $name"
  elif printf '%s' "$out" | grep -q "already exists"; then
    echo "label exists: $name"
  else
    printf '%s\n' "$out" >&2
    return 1
  fi
}

create ai "🤖 AI 处理请求（打上此标签触发流水线）"
create ai-running "⏳ AI 处理中"
create ai-pr "🔀 AI 已创建 PR"
create ai-failed "❌ AI 处理失败（移除后重打 ai 可重试）"
create ai-done "✅ AI 完成（无代码变更）"
create ai-core "🛡️ AI 改动了流水线/CI/安装器，需要人工审查"
create ai-verify-changed "⚠️ 检查配置在运行期间被修改，已用冻结版本复验"
create ai-needs-input "🙋 等待人工决策（回答后 retry）"
create ai-deferred "⏳ 因每日配额/时间预算延后，可安全重试"
create ai-automerge "🤖 已开启 auto-merge（低风险 + 已验证）"
create ai-incident "🚨 AI 合并导致 main 失败（等待回滚）"
create retro "📊 AI 流水线周报"
create "agent:pi" "强制使用 Pi (DeepSeek) 引擎"
create "agent:claude" "强制使用 Claude Code 引擎"
create "agent:codex" "强制使用 Codex 引擎"
create feature "功能/特性（路由到 feature 模板）"
create bug "缺陷（路由到 bug-fix 模板）"
create documentation "文档（路由到 feature 模板）"
echo "done: $REPO"
