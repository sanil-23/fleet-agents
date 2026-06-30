# fleet-agents

Run many [Claude Code](https://claude.com/claude-code) agents in parallel — each in its own
git worktree — and drive them all from one Claude session with a `/fleet` slash command.
You describe the work in plain English; fleet picks the right approach and runs it.

- **macOS / Linux / WSL** → agents are panes in one tmux session you can attach/detach.
  *(tmux is what makes the manager + `/fleet` + `attach` + `resume` flow work — install it.)*
- **No tmux (or Windows)** → fleet still runs, but in **separate-window mode**: the manager
  runs in your current terminal and each worker opens in its own terminal window. There's no
  shared session, so `fleet attach` / tiled panes / `resume` don't apply.

## Install

```bash
npm install -g fleet-agents
fleet install-claude          # adds the /fleet command to Claude Code
```

Needs Node ≥ 16, `git`, the `claude` CLI, and `tmux` (macOS/Linux). Run `fleet doctor` to check.

## Quickstart

**1. Start a manager** — a tmux session with an orchestrator Claude in it. This drops you
straight into the session (no separate attach needed):

```bash
fleet manager --name xyz      # rooted in the current repo (or pass a path: fleet manager --name xyz ~/code/app)
```

**2. Inside that Claude, just describe the work:**

```
/fleet fix the CSV parser crash and add a test
/fleet why is the dashboard query slow?
/fleet keep watching the deploy and ping me when it's green
```

That's the whole loop. For each prompt, fleet spins up a **worker** — its own pane, its own
git worktree (isolated branch) — and sets it going. Detach with `Ctrl-b d` (agents keep
running); come back with `fleet attach --name xyz`, or after a reboot `fleet resume xyz`.

## How `/fleet` decides — skills & modes are auto-picked

When you type `/fleet "<prompt>"`, the manager makes four choices for you, then launches one
worker:

1. **Repo** — the current repo by default (or whichever you name).
2. **Skill** — a prompt template that shapes *how* the agent works. It picks the best fit, or none:

   | Skill | Auto-picked when your prompt is… |
   |-------|----------------------------------|
   | `research` | investigate / debug / "why" / "how does" / trace — **read-only**, produces findings, no code changes |
   | `review` | "review these changes" — CodeRabbit-style review with concrete fixes |
   | `fix` | "review and fix" — applies fixes, runs the repo's checks, commits |
   | *(your own)* | matches a skill you registered (`fleet skill add …`) |
   | *(none)* | a normal implement/fix task |

3. **Mode** — *how it runs*:

   | Mode | Auto-picked when… |
   |------|-------------------|
   | **once** | one-shot task (the default) |
   | **loop** | recurring / monitoring — "every 5 min", "keep checking", "babysit the PR", "until CI is green" |
   | **goal** | drive to an end-state — "keep going until X is done"; runs until that condition holds |

4. **Launch** — creates the worktree and starts the worker with that skill + mode.

The manager tells you what it chose. Want to force a choice? Just name it:

```
/fleet research <thing>         # force the read-only research skill
/fleet review the auth changes  # force the review skill
```

Skills (built-in `research`/`review`/`fix` + your own) all live in one editable folder,
`~/.fleet/skills/` — `fleet skill ls` lists them, `fleet skill init` copies the built-ins there
so you can tweak them, and `fleet skill add <name> <file.md>` registers your own.

## Commands you'll actually use

```bash
fleet manager --name xyz [dir]   # start/open a manager
fleet attach  --name xyz         # jump into it
fleet list-sessions              # tree of everything: managers, their tasks (by name), sub-tasks, child sessions
fleet status  [xyz]              # one session in detail: manager + worker tree
fleet resume  [xyz]              # resume/continue a manager + its workers (claude --continue);
                                 #   bare `fleet resume` continues the most recent manager.
                                 #   already-live sessions aren't duplicated; only missing panes are filled.
fleet kill    --name xyz         # stop the session (keeps the work; resumable)
```

**Resume after a detach, kill, or reboot:** `fleet resume xyz` rebuilds session *xyz* — the
manager plus every worker, each continuing its previous conversation. **Inside tmux** it
rebuilds into your **current** session (as windows) — it won't spin up a separate session;
bare `fleet resume` defaults to the session you're in. Outside tmux it (re)creates the session
and drops you in. Use `fleet list-sessions` to see the names.

**Removing things** — `fleet rm <name>` removes **by name**: a task name, a session name, or
`--self` (no `<repo> <task>` needed; use `<repo>/<task>` only to disambiguate a duplicated task
name). By default it removes the **whole chain it spawned** and **deletes the branches**
(`--no-branch` keeps them, `--no-spawn` removes only the target, `--dry-run` previews). `fleet
rm --self` from a worker removes that worker + its sub-workers; from the manager it removes the
whole session. Same from inside Claude: `/fleet rm <name>`, `/fleet rm self`.

Everything else — manual `fleet add`, custom skills, the `fleet pr` review/fix/merge toolkit —
is in **`fleet help`**.

## Good to know

- Agents run with `--dangerously-skip-permissions` so they work unattended. Each is isolated
  in a throwaway worktree, but they share your real filesystem and credentials — only fan out
  work you'd trust to run on its own. (Set `FLEET_CLAUDE_FLAGS=""` to restore prompts.)
- On macOS, fleet keeps the Mac awake while a session is alive so sleep doesn't kill agents.
- **Inside tmux**, `fleet manager [--name X]` opens a **window** in your current session (named
  X), and re-running just switches to it — it won't spawn a separate tmux session or duplicate
  windows. Pass `--new-session` when you want a fully separate, independently-resumable session
  (the only mode outside tmux). Note: window-mode managers live in your current tmux session, so
  `resume`/`list-sessions` track them at that session level; use `--new-session` for separate state.

## License

MIT
