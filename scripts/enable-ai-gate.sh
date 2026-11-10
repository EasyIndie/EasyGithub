#!/usr/bin/env bash
# Configure the "AI gate" on repositories that already have branch protection:
#   - required status checks (existing ones kept; else derived from PRs/head)
#   - 0 required approvals (single-maintainer zero-click auto-merge)
#   - admin may bypass (enforce_admins=false) for hotfixes
#   - force pushes / deletions stay blocked (untouched)
#
# Only repositories that ALREADY have classic branch protection are touched:
# the point is to align existing gates, not to impose a workflow on repos that
# intentionally stay unprotected.
#
# Usage:
#   bash scripts/enable-ai-gate.sh <owner/repo> [more...] [options]
#     --contexts "a,b"   explicit check contexts
#     --approvals N      required approvals (default 0)
#     --strict           require branches to be up to date (default off)
#     --dry-run          print what would change
set -euo pipefail

REPOS=()
CONTEXTS=""
APPROVALS=0
STRICT="false"
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --contexts) CONTEXTS="${2:-}"; shift 2 ;;
    --approvals) APPROVALS="${2:-0}"; shift 2 ;;
    --strict) STRICT="true"; shift ;;
    --dry-run) DRY=1; shift ;;
    -*) echo "unknown flag: $1" >&2; exit 1 ;;
    *) REPOS+=("$1"); shift ;;
  esac
done

if [ ${#REPOS[@]} -eq 0 ]; then
  echo "usage: $0 <owner/repo> [more...] [--contexts a,b] [--approvals N] [--strict] [--dry-run]" >&2
  exit 1
fi

# Informational checks that must never become a merge gate.
NOISE='^(Dependabot|dependabot|label|merge|Merge|auto-merge|approve|stale|Stale|welcome|Welcome)$'

# `gh api` prints its error JSON on stdout for some 404s; never treat that as a
# check name (a bogus context would block merges forever).
valid_contexts() {
  local c="$1"
  [ -z "$c" ] && return 1
  case "$c" in
    *"{"*|*"}"*|*'"'*|*message*) return 1 ;;
  esac
  return 0
}

existing_classic_contexts() {
  local repo="$1" branch="$2" out
  out=$(gh api "repos/$repo/branches/$branch/protection/required_status_checks" \
    --jq '.contexts[]' 2>/dev/null | paste -sd, - || true)
  valid_contexts "$out" && printf '%s' "$out"
}

pr_contexts() {
  local repo="$1" pr
  pr=$(gh pr list -R "$repo" --state all --limit 10 --json number --jq '.[0].number // empty' 2>/dev/null || true)
  [ -z "$pr" ] && return 0
  # SKIPPED checks never report on a PR, so requiring them would block forever.
  gh pr checks "$pr" -R "$repo" --json name,state \
    --jq '.[] | select(.state != "SKIPPED") | .name' 2>/dev/null || true
}

head_contexts() {
  local repo="$1" branch="$2" sha
  sha=$(gh api "repos/$repo/git/ref/heads/$branch" --jq '.object.sha' 2>/dev/null || true)
  [ -z "$sha" ] && return 0
  gh api "repos/$repo/commits/$sha/check-runs" --jq '[.check_runs[].name] | unique[]' 2>/dev/null || true
}

# A ruleset (other than our own ai-gate) that already enforces status checks.
pre_existing_checks_ruleset() {
  local repo="$1" id count
  for id in $(gh api "repos/$repo/rulesets" --jq '.[] | select(.name != "ai-gate") | .id' 2>/dev/null || true); do
    count=$(gh api "repos/$repo/rulesets/$id" \
      --jq '[.rules[] | select(.type == "required_status_checks")] | length' 2>/dev/null || echo 0)
    if [ "${count:-0}" != "0" ]; then echo "$id"; return 0; fi
  done
}

ruleset_body() {
  AI_CONTEXTS="$1" AI_STRICT="$2" python3 - <<'PYEOF'
import json, os
contexts = json.loads(os.environ["AI_CONTEXTS"])
print(json.dumps({
    "name": "ai-gate",
    "target": "branch",
    "enforcement": "active",
    "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
    "bypass_actors": [],
    "rules": [{
        "type": "required_status_checks",
        "parameters": {
            "strict_required_status_checks_policy": os.environ["AI_STRICT"] == "true",
            "required_status_checks": [{"context": c} for c in contexts],
        },
    }],
}, ensure_ascii=False))
PYEOF
}

apply_checks() {
  local repo="$1" branch="$2" contexts="$3" json_contexts rs_id body
  json_contexts=$(printf '%s' "$contexts" | python3 -c 'import json,sys; print(json.dumps([c.strip() for c in sys.stdin.read().split(",") if c.strip()]))')

  if gh api -X PUT "repos/$repo/branches/$branch/protection/required_status_checks" \
      --input - >/dev/null 2>&1 <<JSON
{"strict": $STRICT, "contexts": $json_contexts}
JSON
  then
    echo "   checks: classic protection updated"
    return 0
  fi

  # Some repos reject the classic sub-endpoint with a bare 404
  # ("Required status checks not enabled"); layer a ruleset instead.
  rs_id=$(gh api "repos/$repo/rulesets" --jq '.[] | select(.name=="ai-gate") | .id' 2>/dev/null | head -1)
  body=$(ruleset_body "$json_contexts" "$STRICT")
  if [ -n "$rs_id" ]; then
    printf '%s' "$body" | gh api -X PUT "repos/$repo/rulesets/$rs_id" --input - >/dev/null
    echo "   checks: updated ruleset ai-gate ($rs_id)"
  else
    printf '%s' "$body" | gh api -X POST "repos/$repo/rulesets" --input - >/dev/null
    echo "   checks: created ruleset ai-gate"
  fi
}

apply_repo() {
  local repo="$1" branch pre_existing contexts
  branch=$(gh api "repos/$repo" --jq '.default_branch' 2>/dev/null) || { echo "SKIP $repo (unreadable)"; return; }
  gh api "repos/$repo/branches/$branch/protection" >/dev/null 2>&1 \
    || { echo "SKIP $repo (no classic branch protection on $branch)"; return; }

  echo "== $repo (branch $branch)"

  pre_existing=""
  if [ -z "$CONTEXTS" ]; then pre_existing=$(pre_existing_checks_ruleset "$repo"); fi

  contexts="$CONTEXTS"
  if [ -n "$pre_existing" ]; then
    echo "   checks: already enforced by ruleset $pre_existing (left as-is)"
  else
    if [ -z "$contexts" ]; then contexts=$(existing_classic_contexts "$repo" "$branch" || true); fi
    if [ -z "$contexts" ]; then
      contexts=$(pr_contexts "$repo" | grep -Ev "$NOISE" | sort -u | paste -sd, - || true)
      valid_contexts "$contexts" || contexts=""
    fi
    if [ -z "$contexts" ]; then
      contexts=$(head_contexts "$repo" "$branch" | grep -Ev "$NOISE" | sort -u | paste -sd, - || true)
      valid_contexts "$contexts" || contexts=""
    fi
    if [ -n "$contexts" ]; then
      echo "   checks: $contexts"
    else
      echo "   checks: none derivable (pass --contexts); approvals only"
    fi
  fi

  echo "   approvals: $APPROVALS  strict: $STRICT  admin bypass: on"
  if [ "$DRY" -eq 1 ]; then
    echo "   (dry-run: nothing written)"
    return
  fi

  if [ -n "$contexts" ] && [ -z "$pre_existing" ]; then
    apply_checks "$repo" "$branch" "$contexts"
  fi

  gh api -X PATCH "repos/$repo/branches/$branch/protection/required_pull_request_reviews" \
    -F dismiss_stale_reviews=true -F required_approving_review_count="$APPROVALS" >/dev/null

  # Admins may hotfix; force pushes / deletions remain blocked.
  gh api -X DELETE "repos/$repo/branches/$branch/protection/enforce_admins" >/dev/null 2>&1 || true

  echo "   applied"
}

for repo in "${REPOS[@]}"; do
  # One repo failing (e.g. a plan limitation) must not abort the batch.
  apply_repo "$repo" || echo "FAILED $repo"
done
