You are finishing PR #__PR__ on `__REPO__`.

The branch `pr/__PR__` is already checked out locally with the base branch merged in and
upstream tracking set — skip any fetch / checkout / merge phases.

`pushRemote` is already wired to the contributor's fork — `git push` from this branch lands
directly on the PR's head branch (`__HEAD_REPO__:__HEAD_BRANCH__`), updating the actual PR. Do
not push to `origin` explicitly; plain `git push` is correct.

__CONFLICT_BLOCK__

# Your job

Two phases, both required:

1. **Review and apply fixes**: do a CodeRabbit-style review of the diff, identify real issues
   (blockers, major, suggestions), and apply the fixes directly to the working tree. Also
   address every existing reviewer/bot comment on the PR (CodeRabbit, maintainers, inline
   threads) — apply each actionable item rather than describing it.
2. **Quality suite, commit, push**: run the repo's formatters / typecheck / lint / tests,
   commit everything in focused commits, and push back to the PR branch.

**Your job is to finish the PR, not to report on it.** A response that only lists what *should*
be done is a failure mode.

# Workflow

## 0. Sanity check the working state

```bash
git status --short                  # should be empty or only your own staged work
git branch --show-current           # should be pr/__PR__
git rev-parse --abbrev-ref @{u}     # upstream must be set
git log --oneline -5
```

If the working tree is dirty in a way you didn't expect, stop and ask — never stash/discard.

## 1. Fetch PR metadata and existing review comments

```bash
gh pr view __PR__ -R __REPO__ --json number,title,headRefName,headRepositoryOwner,headRepository,baseRefName,isCrossRepository,state,author,url,body,mergeable,statusCheckRollup
gh pr diff __PR__ -R __REPO__
gh pr view __PR__ -R __REPO__ --json reviews --jq '.reviews[] | {author: .author.login, state: .state, body: .body, submittedAt: .submittedAt}'
gh api repos/__REPO__/pulls/__PR__/comments --paginate
gh api repos/__REPO__/issues/__PR__/comments --paginate
```

Confirm the PR is **open**. Abort on closed/merged unless the user says otherwise.

For cross-repo forks where local `pr/__PR__` was pushed to your own `origin` (not the
contributor's fork), pushes update your origin copy — **not the actual PR**. Flag this clearly.

## 2. Read every changed file in full

Read the **whole file** (not just the hunk). Read siblings for new files; check both paths for
moves/renames. Skipping this produces shallow fixes.

## 3. Analyze + classify each existing comment and your own findings

Run a CodeRabbit-style review against these axes:

**Correctness** — logic bugs, off-by-one, null/undefined, async/await misuse, race conditions,
error propagation and handling.

**Project standards** — read the repo's own `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING` and
linter/formatter config, and hold the change to *those* conventions (module layout, error
handling, logging style, file-size limits). Don't impose rules the project doesn't follow.

**Testing** — new behavior ships with tests using the repo's framework; cover branches and
error paths.

**Security** — credentials, command injection, SQL injection, path traversal, XSS.

Classify each existing comment and new finding:
- `actionable-trivial` — typo, rename, formatting, missing import: fix directly.
- `actionable-non-trivial` — logic/architecture/test gap: fix if direction is unambiguous;
  otherwise defer.
- `already-addressed` — current code satisfies it.
- `stale-outdated` — no longer applies.
- `disagree` / `defer-human` / `question` — surface in the final report and post back as a PR
  comment via `gh api`; never silently dismiss.

## 4. Apply fixes (REQUIRED)

Apply every `actionable-trivial` and clearly-directed `actionable-non-trivial` fix. Re-read
surrounding code before each edit (state may have drifted since the comment was written).

One logical concern per commit:

```text
fix(<area>): <what changed> (addresses @<reviewer> on <file>:<line>)
refactor(<area>): <what changed>
test(<area>): <what added>
docs(<area>): <what changed>
chore(pr-fix): apply formatting
```

Skip anything you choose not to apply (capture the reason for the final report). Don't expand
scope.

## 5. Run the quality suite

Detect the repo's checks from its manifests (`package.json` / `Cargo.toml` / `Makefile` /
`pyproject.toml` / etc.) and run them — formatters, typecheck/lint, and tests. Run independent
suites in parallel; always run the formatter + typecheck when code changed.

If a test fails on apparent flake, rerun once. If it still fails, stop and report.

## 6. Commit any auto-fixes

- Formatter changes → `chore(pr-fix): apply formatting`.
- Non-trivial lint autofixes → `chore(pr-fix): lint autofix`.
- `git status --short` must be empty before push.
- Never `--no-verify` unless a pre-push hook fails on pre-existing breakage unrelated to your
  changes — in that case, push with `--no-verify` and note it in the report.
- Never amend published commits. Never force-push without explicit user approval.

## 7. Push (REQUIRED)

```bash
git status --short    # must be empty
git push              # pushes to the contributor's fork (__HEAD_REPO__:__HEAD_BRANCH__) — updates the PR
```

If rejected (non-fast-forward — the contributor pushed while you worked): `git pull --rebase`
then push. **Never** force-push without explicit user approval.

If the push fails with a permissions error (no write access to the contributor's fork): stop,
do NOT fall back to `origin`, and report — the user needs access or the contributor must pull
the changes themselves.

## 8. Post deferred / disagree / question items back to the PR

For every item classified `disagree`, `defer-human`, or `question`, post it as an inline review
comment via `gh api` so nothing is lost in chat:

```bash
gh api -X POST repos/__REPO__/pulls/__PR__/comments \
  -f body="<your reply>" \
  -f commit_id="$(gh pr view __PR__ -R __REPO__ --json headRefOid --jq .headRefOid)" \
  -f path="<file path>" \
  -F line=<line number> \
  -f side=RIGHT
```

## 9. Final report (to the user)

```text
## PR #__PR__ - <title>
Branch: pr/__PR__  PR head: <headRefName>  Base: <baseRefName>  Author: <login>

### Preconditions
- Working tree clean at start: yes/no
- Branch / upstream verified: yes/no
- Cross-repo fork: yes/no — push target: <origin/<branch> | contributor-fork>

### Review comments processed (<count>)
- @<reviewer> on <file>:<line> - <one-line> -> fixed / already addressed / deferred / disagree

### New findings raised (<count>)
- <severity> <file>:<line> - <one-line> -> fixed / deferred

### Checks
| Check | Result |
|---|---|
| typecheck | pass/fail |
| lint | pass/fail (N autofixes) |
| format | pass |
| tests | <passed>/<total> |

### Commits pushed
- <sha> <subject>

### Outstanding human items
- <list, or none>

### PR
<url>
```

# Guardrails

- **Never** push to `main`, force-push, skip hooks (except the documented pre-existing-breakage
  case), amend published commits, or run destructive git commands without explicit user approval.
- **Never** commit secrets (`.env`, `*.key`, credentials).
- If the working tree is dirty at start in unexpected ways, **stop** — don't stash.
- If tests flake, rerun once; if still failing, report rather than loop.
- Stay on the PR branch; never accidentally commit to the base branch.
- Keep findings honest. If the PR is clean, say so. Don't pad with invented issues.
