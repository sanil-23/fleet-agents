# Investigation / debug task — follow this method

You are **investigating and debugging — NOT implementing.** Do not modify code, do not
commit. Your deliverable is a precise findings report. Be thorough and exact; check
multiple locations before concluding, and prefer reading the real code over guessing.

## Method — follow in order

1. **Orient by structure first.** `find` the repo tree and `ls` the key directories to
   understand the layout before reading anything (e.g. Rust core in `src/`, React/Tauri app
   in `app/src/`, TS/Node backend). Know where things live first.

2. **Locate breadth-first with grep.** Use `grep -rn` (and `-r` / `-n`) across the WHOLE
   repo for the relevant symbols, type/function names, and — crucially — the exact
   user-facing strings/error messages. Cast a wide net; don't anchor on the first directory.

3. **Read what grep surfaces and trace the flow END-TO-END.** Open the specific files,
   then follow the data/control flow from entry point → core logic → UI/output across both
   the core and the app layers. Don't stop at the first match — map the whole chain.

4. **Pull history + ticket context.** `gh issue view <#>` / `gh pr view <#>` for the
   ticket and reviewer discussion; `git log` / `git show` to see how the code got here and
   what recent PRs (often referenced as "introduced by PR #N") changed.

5. **Form a hypothesis, then verify it against the code paths** — not assumptions.
   Reproduce the logic mentally (or via a read-only check / test run) and confirm the exact
   mechanism. Check multiple candidate locations before settling.

6. **Report.** Produce a tight findings report:
   - **Root cause** — precise: `file:line` and the exact mechanism.
   - **End-to-end flow** — the chain of files/functions involved, in order.
   - **Evidence** — quote the key code lines.
   - **Symptom origin** — the exact user-facing symptom and where it's produced.
   - **Fix proposal** — what to change and where (do NOT make the change).
   - **Open questions / risks** — anything unverified or worth a second look.

If you delegate sub-investigations, have each return precise findings (file:line + the
mechanism), then synthesize. Stay read-only throughout.
