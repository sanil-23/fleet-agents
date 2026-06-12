#!/usr/bin/env bash
# Shared helpers for scripts/shortcuts/review/*.sh
# Source this file; do not execute directly.

set -euo pipefail

# Repo that hosts the PR. Override with REVIEW_REPO=owner/name if needed;
# otherwise we derive it from the `upstream` remote, falling back to `origin`.
resolve_repo() {
  if [ -n "${REVIEW_REPO:-}" ]; then
    echo "$REVIEW_REPO"
    return
  fi
  local url
  url=$(git remote get-url upstream 2>/dev/null || git remote get-url origin)
  # Accept git@github.com:owner/name(.git) and https://github.com/owner/name(.git)
  echo "$url" \
    | sed -E 's#^git@github\.com:##; s#^https?://github\.com/##; s#\.git$##'
}

require() {
  local bin
  for bin in "$@"; do
    command -v "$bin" >/dev/null 2>&1 || {
      echo "[review] missing required tool: $bin" >&2
      exit 1
    }
  done
}

# Run the picked agent CLI on a single positional prompt. Each known agent
# is launched in its equivalent "yolo" mode so headless / detached runs
# (CI, background tasks, tmux workers) don't stall on per-tool permission
# prompts that have no responder. Set REVIEW_AGENT_SAFE=1 to keep the
# prompts (e.g. an interactive local run where you want to vet each step).
#
# Mirrors the precedent in bin/spawn-issue, which already passes
# --dangerously-skip-permissions to its detached claude workers, and brings
# the claude path in line with the existing codex / cursor handling.
agent_exec() {
  local agent="$1"
  local prompt="$2"
  if [ "${REVIEW_AGENT_SAFE:-0}" = "1" ]; then
    case "$agent" in
      codex) exec codex "$prompt" ;;
      claude) exec claude "$prompt" ;;
      *) exec "$agent" "$prompt" ;;
    esac
    return
  fi
  case "$agent" in
    claude)
      exec claude --dangerously-skip-permissions "$prompt"
      ;;
    codex)
      exec codex --dangerously-bypass-approvals-and-sandbox "$prompt"
      ;;
    cursor|cursor-agent)
      exec cursor-agent --yolo "$prompt"
      ;;
    *)
      exec "$agent" "$prompt"
      ;;
  esac
}

gh_assign_self_issue() {
  local issue="$1"
  local repo="$2"
  if gh issue edit "$issue" -R "$repo" --add-assignee "@me" >/dev/null 2>&1; then
    info "assigned issue #$issue to @me"
  else
    warn "could not assign issue #$issue to @me; continuing"
  fi
}

gh_assign_self_pr() {
  local pr="$1"
  local repo="$2"
  if gh pr edit "$pr" -R "$repo" --add-assignee "@me" >/dev/null 2>&1; then
    info "assigned PR #$pr to @me"
  else
    warn "could not assign PR #$pr to @me; continuing"
  fi
}

# Summarize free-form text via a local LLM CLI (expects `-p <prompt>`).
# Usage: summarize_text <tool> <input>
# Tools used here: gemini (default for summaries), claude, or any CLI that
# accepts `-p "<prompt>"` and prints the response to stdout.
# Special value `none` echoes input unchanged.
summarize_text() {
  local tool="$1"
  local input="$2"
  if [ "$tool" = "none" ] || [ "$tool" = "raw" ]; then
    printf '%s' "$input"
    return
  fi
  require "$tool"
  local prompt
  prompt=$(cat <<'EOF'
You are writing the body of a squash-merge commit.
Summarize the PR changes below into 3-6 short bullet points.
Rules:
- Start each bullet with "- " and use imperative mood ("Add…", "Fix…", "Rename…").
- One line per bullet, under ~100 chars.
- No headers, no code fences, no sign-offs, no Co-authored-by lines.
- Do not include the PR number or title.
- Output only the bullets, nothing else.

PR content:
---
EOF
)
  "$tool" -p "${prompt}
${input}
---"
}

require_pr_number() {
  if [ -z "${1:-}" ]; then
    echo "Usage: $(basename "$0") <pr-number>" >&2
    exit 1
  fi
  case "$1" in
    ''|*[!0-9]*)
      echo "[review] pr-number must be numeric, got: $1" >&2
      exit 1
      ;;
  esac
}

# ── Coloured output ────────────────────────────────────────────────
# Disable colour when stdout is not a terminal (piped / CI).
if [ -t 1 ]; then
  _R=$'\033[0;31m' _G=$'\033[0;32m' _Y=$'\033[0;33m' _B=$'\033[1m' _0=$'\033[0m'
else
  _R="" _G="" _Y="" _B="" _0=""
fi

pass()  { printf '%s[PASS]%s %s\n' "$_G" "$_0" "$*"; }
fail()  { printf '%s[FAIL]%s %s\n' "$_R" "$_0" "$*" >&2; }
warn()  { printf '%s[WARN]%s %s\n' "$_Y" "$_0" "$*" >&2; }
info()  { printf '%s[INFO]%s %s\n' "$_B" "$_0" "$*"; }

# Fetch PR head into local branch pr/<num>, merge main in, wire upstream +
# pushRemote so `git push` lands on the contributor's fork.
sync_pr() {
  local pr="$1"
  local repo
  repo=$(resolve_repo)

  local info head_repo head_branch local_branch base_branch
  info=$(gh pr view "$pr" -R "$repo" \
    --json headRefName,headRepository,headRepositoryOwner,baseRefName)
  head_repo=$(echo "$info" | jq -r '.headRepositoryOwner.login + "/" + .headRepository.name')
  head_branch=$(echo "$info" | jq -r '.headRefName')
  # The PR's actual base branch (e.g. develop) is authoritative; don't assume main.
  base_branch=$(echo "$info" | jq -r '.baseRefName')
  [ -z "$base_branch" ] || [ "$base_branch" = "null" ] && base_branch="main"
  local_branch="pr/$pr"

  echo "[review] PR #$pr -> $head_repo:$head_branch (base: $base_branch, local: $local_branch)"

  # Fetch the PR head into local branch pr/<n> (refs are shared across worktrees).
  git fetch origin "$base_branch"
  # On a reused review worktree, pr/<n> is already checked out, and fetching
  # directly into a checked-out branch is fatal. Only seed the branch on first
  # creation; reuse refreshes it via the push remote further down.
  if git rev-parse --verify --quiet "refs/heads/${local_branch}" >/dev/null; then
    echo "[review] $local_branch already exists — skipping direct head fetch (refreshed via push remote below)"
  else
    git fetch "https://github.com/${head_repo}.git" \
      "+${head_branch}:${local_branch}"
  fi

  local merge_ref="$base_branch"
  if [ "${REVIEW_WORKTREE:-0}" = "1" ]; then
    # Isolated review worktree: never touch the primary checkout's branch.
    local wt="${REVIEW_WT_DIR:?[review] REVIEW_WT_DIR required in worktree mode}"
    if [ -d "$wt" ]; then
      echo "[review] reusing review worktree: $wt"
      cd "$wt"
      git checkout "$local_branch"
    else
      echo "[review] creating review worktree: $wt (branch $local_branch)"
      mkdir -p "$(dirname "$wt")"
      git worktree add --force "$wt" "$local_branch"
      cd "$wt"
    fi
    # Bring the base branch in via a ref (it may be checked out elsewhere).
    merge_ref="origin/$base_branch"
    if git remote get-url upstream >/dev/null 2>&1; then
      git fetch upstream
      git rev-parse --verify "upstream/$base_branch" >/dev/null 2>&1 && merge_ref="upstream/$base_branch"
    fi
  else
    echo "[review] syncing $base_branch from upstream..."
    git checkout "$base_branch"
    git pull origin "$base_branch"
    git fetch upstream
    git merge "upstream/$base_branch"
    git checkout "$local_branch"
  fi
  # A stray gitlink without a matching .gitmodules entry (e.g. an accidentally
  # committed .claude/worktrees/* path) makes this fatal under `set -e` and would
  # abort the whole review. Submodules aren't needed to review a diff, so warn and
  # continue rather than die.
  git submodule update --init --recursive \
    || warn "submodule update failed (continuing) — likely a stale gitlink with no .gitmodules entry"

  echo "[review] merging $merge_ref into $local_branch (conflicts will not abort)..."
  REVIEW_HAS_CONFLICTS=0
  REVIEW_CONFLICT_FILES=""
  if ! git merge --no-edit "$merge_ref"; then
    REVIEW_CONFLICT_FILES=$(git diff --name-only --diff-filter=U | sort -u)
    if [ -z "$REVIEW_CONFLICT_FILES" ]; then
      fail "git merge $merge_ref failed for a non-conflict reason"
      return 1
    fi
    echo "[review] ! conflicts detected in PR #$pr, continuing."
    REVIEW_HAS_CONFLICTS=1
  fi

  # Prefer an existing SSH remote pointing at this fork to avoid https auth prompts.
  local remote_name="remote-$pr"
  local existing_ssh
  existing_ssh=$(git remote -v \
    | awk -v repo="$head_repo" '$2 ~ ("[:/]" repo "(\\.git)?$") && $3 == "(fetch)" {print $1; exit}')
  if [ -n "$existing_ssh" ]; then
    remote_name="$existing_ssh"
    echo "[review] reusing remote '$remote_name' -> $(git remote get-url "$remote_name")"
  else
    local remote_url="https://github.com/${head_repo}.git"
    git remote add "$remote_name" "$remote_url" 2>/dev/null \
      || git remote set-url "$remote_name" "$remote_url"
  fi

  git fetch "$remote_name" \
    "+refs/heads/${head_branch}:refs/remotes/${remote_name}/${head_branch}"

  git branch --set-upstream-to="$remote_name/$head_branch" "$local_branch"
  git config "branch.${local_branch}.pushRemote" "$remote_name"
  git config "branch.${local_branch}.merge" "refs/heads/${head_branch}"

  echo "[review] upstream + pushRemote set to $remote_name/$head_branch"

  # Export for callers.
  REVIEW_PR="$pr"
  REVIEW_REPO_RESOLVED="$repo"
  REVIEW_LOCAL_BRANCH="$local_branch"
  REVIEW_HEAD_REPO="$head_repo"
  REVIEW_HEAD_BRANCH="$head_branch"
  REVIEW_PUSH_REMOTE="$remote_name"
  export REVIEW_PR REVIEW_REPO_RESOLVED REVIEW_LOCAL_BRANCH \
         REVIEW_HEAD_REPO REVIEW_HEAD_BRANCH REVIEW_PUSH_REMOTE \
         REVIEW_HAS_CONFLICTS REVIEW_CONFLICT_FILES
}
