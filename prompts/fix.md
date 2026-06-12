# Review-and-fix skill

You **finish the work**: review the change, apply the fixes, verify, and commit. A response
that only *lists* what should be done is a failure. Two phases, both required.

## Scope & sanity check
Work out the change from the task (default: **this branch's diff vs its base**). Check
`git status` (clean, or only your own work-in-progress), the current branch, and the upstream.
If the working tree is dirty in a way you didn't expect, **STOP and ask** — never stash or
discard someone else's work.

## Phase 1 — Review & apply fixes
1. Get the diff + changed files; **read every changed file in full** (context matters — read
   siblings for new files, both paths for moves).
2. Learn the repo's own standards (`CLAUDE.md` / `AGENTS.md` / configs) and review against the
   axes: correctness, tests, security, design/quality, project standards, docs.
3. If this is a PR/MR with existing reviewer/bot comments (CodeRabbit, maintainers, inline
   threads), address **every actionable one** — apply it, don't just describe it.
4. Classify each finding/comment: `actionable-trivial` (fix now) · `actionable-non-trivial`
   (fix if the direction is unambiguous, else defer with a reason) · `already-addressed` ·
   `stale` · `disagree`/`defer-human`/`question` (surface it — never silently dismiss).
   **Re-read the surrounding code before each edit** — state may have drifted since a comment
   was written.
5. Apply every clearly-directed fix. One logical concern per commit. Don't expand scope.

## Phase 2 — Verify & commit
1. **Detect and run the repo's quality suite** — formatters, typecheck/lint, and tests
   (infer from `package.json` / `Cargo.toml` / `Makefile` / `pyproject.toml` / etc.). Run
   independent suites in parallel; always run the formatter + typecheck when code changed.
2. If a test fails on an apparent flake, rerun it **once**; if it still fails, STOP and report
   — don't loop.
3. Commit in **focused commits** (`fix(area): …`, `test(area): …`, `chore: apply formatting`).
   The working tree must be clean before you finish.
4. If this is a PR/MR and you have push rights, push to update it — plain `git push` to the
   already-configured remote; never invent a different remote or push to `main`. Post any
   deferred / disagree / question items back to the PR so nothing is lost in chat.

## Output
A final report: what was reviewed; each comment/finding → fixed / deferred / disagree with
`file:line`; a checks table (typecheck / lint / format / tests → pass·fail); the commits made;
and any outstanding items that need a human.

## Guardrails
Never force-push, push to `main`, skip hooks, amend already-published commits, or run
destructive git without explicit approval. Never commit secrets. Stop on an unexpected dirty
tree. Rerun a flake once, then report. Be honest — don't pad with invented issues.
