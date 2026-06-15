---
description: Spin up / manage parallel Claude Code agents, each in its own git worktree
argument-hint: <prompt>  |  <repo>: <task>; <repo>: <task>...  |  ls  |  rm <repo> <task>
allowed-tools: Bash(fleet:*), Bash(fleet add:*), Bash(fleet ls:*), Bash(fleet rm:*), Bash(fleet kill:*), Bash(fleet skill:*)
---

You are driving the `fleet` CLI (on PATH) — it creates an isolated git worktree per task
and launches an interactive `claude` for it (a tmux pane on macOS/Linux, or a separate
terminal window on Windows). Run it via Bash. Do NOT do the worktree/terminal work yourself.

User input: `$ARGUMENTS`

## Routing

- Empty input, or `ls`/`list`/`status` → run `fleet ls`.
- `rm`/`remove`/`done <name>` → `fleet rm <name>`. `<name>` is a **task name** or a session name
  (fleet resolves it). By default this removes the target **and every sub-worker/child it
  spawned** (the chain): closes panes, removes worktrees, **and deletes branches**. Add
  `--no-branch` to keep branches, `--no-spawn` to remove only the target. (If a task name is
  duplicated across repos, qualify it as `<repo>/<task>`.)
- `rm self` / "remove this worker" / "kill me and my workers" → `fleet rm --self`. From a
  **worker** it removes that worker + its sub-workers; from the **manager** it removes the WHOLE
  session (manager + all workers). Branches deleted by default (use `--no-branch` to keep).
- `kill`/`teardown` → `fleet kill`.
- `resume …` → `fleet resume …`.
- Anything else → it's one or more **task launches**. For each, run the **Dispatch decision**.

## Dispatch decision (run for EVERY task launch)

The user gives a task in plain language (often `<repo>: <what to do>`, or just a prompt;
multiple tasks separated by `;`/newlines, or a `.md` file path). For each task, decide four
things, THEN issue one `fleet add`:

**1. Repo + slug.** Repo = the name they gave; if none, default to the current repo by
passing `.`. Only ask if the cwd isn't a git repo or they clearly meant several repos.
Slug = a short kebab-case name from the description (≤25 chars).

**2. Skill** — *you choose it.* Run `fleet skill ls` to see what's registered, then pick the
single best-fit skill for THIS task, or none:
   - Investigate / trace / "why" / "how does" / audit / debug-only (NO code change wanted)
     → `research` (it's read-only — only pick it when the user wants understanding, NOT a fix).
   - A user skill whose name/purpose matches the task (e.g. a `refactor` skill for "clean up
     X") → that skill.
   - Nothing fits, or it's a normal implement/fix task → no skill.
   When unsure between a skill and none, prefer none. Briefly say which skill you picked and why.

**3. Mode** — how the worker should run:
   - **once** (default) — a one-shot task.
   - **loop** — recurring / polling / monitoring work: "every N min", "keep checking",
     "watch", "babysit the PR", "until CI is green". Seed the worker to start in loop mode.
   - **goal** — a long autonomous push to a definite END-STATE ("keep going until X is done/
     true"). Uses Claude Code's built-in `/goal <condition>`, which sets a Stop hook that
     blocks the worker from stopping until the CONDITION holds (auto-clears when met). Phrase
     the task as the end-state/condition to reach, not an action.

**4. Launch** — construct exactly one `fleet add`:
   - once + skill:  `fleet add <repo> <slug> "<task>" --skill <name>`
   - once, no skill: `fleet add <repo> <slug> "<task>"`   (or a `.md` file path as the prompt)
   - loop:          `fleet add <repo> <slug> "/loop <interval-or-blank> <task>"`
   - goal:          `fleet add <repo> <slug> "/goal <completion-condition>"`  (phrase as end-state)
   For loop/goal, the worker's FIRST message must be the slash command, so do NOT also pass
   `--skill` (it would prepend text before the slash); instead fold any skill guidance into
   the `<task>` text. Append a base branch only if the user named one. Add `--no-worktree`
   only if they want it to run in the repo itself (e.g. read-only research).

Launch independent tasks in parallel (multiple `fleet add` calls in one message).

## Managing skills

If the user asks to register/list/remove skills, use `fleet skill ls | add <name> <file.md>
| rm <name> | show <name>`.

## After launching

Report a compact table: `repo/slug` → skill · mode · one-line task. Then remind them:
- `fleet attach` in a terminal to watch/steer (tmux backend; you can't attach from here).
- `/fleet ls` for progress, `/fleet rm <repo> <task>` to clean one up when merged.

If a `fleet add` fails (e.g. unknown repo), surface the error and suggest a fix rather than
retrying blindly.
