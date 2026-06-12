You are doing a CodeRabbit-style review of PR #__PR__ on `__REPO__`.

The branch `pr/__PR__` is already checked out locally with the base branch merged in and
upstream tracking set — skip any fetch / checkout / merge phases.

__CONFLICT_BLOCK__

# Your job

Produce a thorough CodeRabbit-style review: walkthrough, change summary table, per-file
analysis, actionable inline comments with concrete code suggestions, and a nitpick section.
Then **post the review and any inline comments via `gh`**. If the changes look acceptable
overall, approve with `gh pr review __PR__ -R __REPO__ --approve`. If blocking issues remain,
request changes instead.

Do NOT apply code changes — this is a review-only task.

# Workflow

## 1. Fetch PR metadata and diff

```bash
gh pr view __PR__ -R __REPO__ --json number,title,headRefName,baseRefName,isCrossRepository,state,author,url,body,mergeable,additions,deletions,changedFiles
gh pr diff __PR__ -R __REPO__
gh pr view __PR__ -R __REPO__ --json files --jq '.files[] | {path, additions, deletions}'
```

Abort on closed/merged PRs unless the user insists. Note cross-repo/fork status.

## 2. Read every changed file in full

For every file in the diff:
- Read the **whole file**, not just the hunk. Context matters.
- For new files, read siblings in the same directory to learn local conventions.
- For moved/renamed files, check both old and new paths.

Skipping this produces shallow reviews that miss architectural issues.

## 3. Analyze against these axes

**Correctness** — logic bugs, off-by-one, null/undefined, async/await misuse, race
conditions, resource leaks, error propagation and handling.

**Project standards** — read the repo's own `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING` and
its linter/formatter/editorconfig, and hold the change to *those* conventions (module layout,
error-handling patterns, logging style, file-size limits, naming). Don't impose rules the
project doesn't follow.

**Testing** — new behavior ships with tests using the repo's framework; cover branches and
error paths; test behavior over implementation; no real network, no time-based flakes.

**Debug logging** — meaningful logs on new flows (entry/exit, branches, retries, state
transitions) with grep-friendly prefixes; never log secrets or PII.

**Security** — credentials, command injection, SQL injection, path traversal, XSS, secret
files (`.env`, `*.key`), validation at trust boundaries.

**Design / code quality** — dead code, commented-out blocks, unexplained TODOs,
over-abstraction, duplication, backwards-compat cruft, "what" comments instead of "why".

**UX / UI** (frontend changes) — accessibility, keyboard nav, loading/error/empty states,
responsiveness.

**Documentation** — comments/API docs match new behavior; architecture/usage docs updated for
behavior or rule changes.

## 4. Classify findings

For each finding, tag:
- **Severity**: `blocker` (must fix before merge), `major` (should fix), `minor` / `nitpick`
  (optional polish), `question` (needs discussion).
- **Confidence**: `high` / `medium` / `low`.

Drop `low`-confidence `minor` items — they're noise. Keep real issues; don't pad the review.

## 5. Emit and post the review

Format the review using the structure below, then post it as a single review on the PR using
`gh pr review __PR__ -R __REPO__ --body-file -` (or `--body "..."`). For each per-file
actionable item, also post an inline review comment via `gh api repos/__REPO__/pulls/__PR__/comments`
so it lands on the right line in the diff:

```bash
gh api -X POST repos/__REPO__/pulls/__PR__/comments \
  -f body="<comment body>" \
  -f commit_id="$(gh pr view __PR__ -R __REPO__ --json headRefOid --jq .headRefOid)" \
  -f path="<file path>" \
  -F line=<line number> \
  -f side=RIGHT
```

Review body structure:

````markdown
# PR #__PR__ — <title>

## Walkthrough
<2–4 sentence prose summary of what the PR does, the approach taken, and overall assessment.>

## Changes

| File | Summary |
| --- | --- |
| `path/to/file1` | <1-line summary> |
| `path/to/file2` | <…> |

## Actionable comments (<count>)

### 🛑 Blockers

#### 1. `path/to/file:42-56` — <short title>
<2–5 line explanation of the issue, why it's wrong, and the downstream effect.>

**Suggested change:**
```
// before
<snippet>

// after
<snippet>
```

### ⚠️ Major
#### 2. `path/to/other:110-128` — <short title>
<…same structure…>

### 💡 Refactor / suggestion
#### 3. `path/to/thing:200-240` — <short title>
<…>

## Nitpicks (<count>)
- `path/to/file:15` — prefer `const` over `let`; not reassigned.

## Questions for the author (<count>)
- `path/to/file:88` — <question>

## Verified / looks good
- <what you checked that's correct>
````

Rules:
- Use **file:line** or **file:line-range** for every actionable item.
- Every actionable comment must include a **concrete proposed fix** — a code block where
  plausible. "Consider refactoring" is not a suggestion.
- Before/after code blocks should be minimal.
- Do not invent issues. If the PR is clean, say so and keep it short.
- Do not repeat what the linter/compiler would catch unless CI hasn't caught it.

## 6. Approve or request changes

After posting the review:
- No blockers, no major issues: `gh pr review __PR__ -R __REPO__ --approve`.
- Blockers exist: `gh pr review __PR__ -R __REPO__ --request-changes --body "See review above."`.
- Otherwise: leave it as a plain `--comment`.

## 7. Final report (to the user)

```text
## PR #__PR__ — Review posted
### Findings raised: <total>  (blockers <n>, major <n>, suggestions <n>, nitpicks <n>, questions <n>)
### Action: posted review <yes/no>, inline comments <n>, final state APPROVED / CHANGES_REQUESTED / COMMENTED
### PR URL: <url>
```

# Guardrails

- This is review-only. Do NOT edit code, commit, or push.
- Never approve a PR with unresolved blockers.
- Keep the review honest. If the PR is good, say so.
- Never log secrets or full PII in comments.
