# fleet-agents

Run many [Claude Code](https://claude.com/claude-code) agents in parallel — each in its own
git worktree — and drive them all from one Claude session with a `/fleet` slash command.
You describe the work in plain English; fleet picks the right approach and runs it.

- **macOS / Linux / WSL** → agents are panes in one tmux session you can attach/detach.
- **Windows** → each agent opens in its own terminal window.

## Install

```bash
npm install -g fleet-agents
fleet install-claude          # adds the /fleet command to Claude Code
```

Needs Node ≥ 16, `git`, the `claude` CLI, and `tmux` (macOS/Linux). Run `fleet doctor` to check.

## Quickstart

**1. Start a manager** — a tmux session with an orchestrator Claude in it:

```bash
fleet manager --name xyz      # rooted in the current repo (or: fleet manager --name xyz ~/code/app)
fleet attach --name xyz       # hop into the session
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

(See the built-in + your skills with `fleet skill ls`.)

## Commands you'll actually use

```bash
fleet manager --name xyz [dir]   # start/open a manager
fleet attach  --name xyz         # jump into it
fleet status  [xyz]              # what's running: manager + worker tree
fleet resume  [xyz]              # rebuild after a reboot (agents continue where they left off)
fleet kill    --name xyz         # stop the session (keeps the work; resumable)
```

From inside Claude you can also say `/fleet ls`, `/fleet status`, or `/fleet rm <repo> <task>`
(removes a worker and anything it spawned), and `/fleet rm self` from inside a worker.

Everything else — manual `fleet add`, custom skills, the `fleet pr` review/fix/merge toolkit —
is in **`fleet help`**.

## Good to know

- Agents run with `--dangerously-skip-permissions` so they work unattended. Each is isolated
  in a throwaway worktree, but they share your real filesystem and credentials — only fan out
  work you'd trust to run on its own. (Set `FLEET_CLAUDE_FLAGS=""` to restore prompts.)
- On macOS, fleet keeps the Mac awake while a session is alive so sleep doesn't kill agents.
- Run several managers at once with different `--name`s (one per project/effort).

## License

MIT
