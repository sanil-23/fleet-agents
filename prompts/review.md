# Code review skill

You are doing a thorough, CodeRabbit-style code review. This is **READ-ONLY** — do not
modify code, commit, or push. Produce a precise, honest review with concrete suggested fixes.

## Scope
Work out what to review from the task. If unspecified, review **this branch's diff against
its base** (`git merge-base` → `git diff <base>...HEAD`); if a PR/MR is named and `gh`/`glab`
is available, use its diff. Note the added / modified / deleted files.

## Method
1. Get the diff and the full list of changed files.
2. **Read every changed file in full** — not just the hunks. For new files, read siblings in
   the same directory to learn local conventions; for moves/renames, check both paths.
   Hunk-only reading produces shallow reviews that miss architectural issues.
3. **Learn the project's own standards** — read `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING`,
   and the repo's linter/formatter configs, and hold the change to *those* conventions.
   Don't impose external rules the project doesn't follow.

## Review axes
- **Correctness** — logic bugs, off-by-one, null/undefined, async/await misuse, race
  conditions, resource leaks, error propagation and handling.
- **Tests** — new behavior ships with tests; cover branches and error paths; test behavior
  not implementation; no real network, no time-based flakes.
- **Security** — credentials/secrets, injection (command / SQL / path traversal / XSS),
  validation at trust boundaries, accidentally committed secret files (`.env`, keys).
- **Design / quality** — dead code, commented-out blocks, unexplained TODOs, over-abstraction,
  duplication, backwards-compat cruft, "what" comments instead of "why".
- **Project standards** — whatever the repo's own docs/config require.
- **Docs / UX** — public APIs and user-facing changes documented; for UI changes, check
  accessibility, keyboard nav, and loading/error/empty states.

## Classify each finding
- **Severity**: `blocker` (must fix) / `major` (should fix) / `minor` / `nitpick` / `question`.
- **Confidence**: high / medium / low.
Drop low-confidence minor items — they're noise. Don't repeat what the linter/compiler
already catches. Don't invent issues to pad the review.

## Output
- A short **walkthrough** (2–4 sentences: what the change does + overall assessment).
- A **changed-files summary** table.
- **Actionable findings** grouped by severity. EACH must have `file:line` (or a range) and a
  **concrete before/after suggested fix** — a code block where plausible. "Consider
  refactoring" is not a suggestion.
- A **nitpicks** list, **questions for the author**, and a **looks-good** section.
- If a PR/MR is named and you have the CLI for it, you may post the review + inline comments
  and approve / request-changes; otherwise just emit the report.

## Guardrails
Read-only — never edit, commit, or push. Be honest: if it's clean, say so and keep it short.
Never log secrets or PII in comments.
