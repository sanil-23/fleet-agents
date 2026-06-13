# fleet-agents

Run many [Claude Code](https://claude.com/claude-code) agents in parallel — each in its own
isolated **git worktree** with its own task — and orchestrate them from one place, including
from *inside* a Claude session via a `/fleet` slash command.

- **macOS / Linux / WSL** → agents run as panes in one **tmux** session you can attach/detach.
- **Windows** → each agent opens in its own terminal window (no tmux needed).

## Concepts (the mental model)

| Term | What it is |
|------|-----------|
| **session** | One tmux session — the container. Survives detach/reboot (state is saved). |
| **manager** | The orchestrator Claude in pane 0 of a session. You type `/fleet …` into it. |
| **worker** | An agent in its own pane + git **worktree** (isolated branch), working one task. |
| **sub-worker** | A worker a worker spawned — fleet tracks the chain so you can resume/remove it as a unit. |
| **skill** | A named prompt template prepended to a task (`research`, `review`, `fix`, or your own). |
| **mode** | How a worker runs: **once** (one-shot), **loop** (recurring), **goal** (until a condition holds). |

## Install

```bash
npm install -g git+https://github.com/sanil-23/fleet-agents.git   # (or 'fleet-agents' once on npm)
fleet install-claude     # adds the /fleet slash command to ~/.claude/commands
fleet doctor             # check prerequisites
```

**Requires:** Node ≥ 16, `git`, the `claude` CLI on PATH. `tmux` on macOS/Linux (Windows uses
separate windows). `fleet pr …` review commands also need `gh` + `jq`.

## Quickstart

```bash
cd ~/code/myapp          # any git repo
fleet manager            # opens a manager Claude here, in a tmux session
fleet attach             # (in your terminal) hop into the session
```
Then, **inside the manager**, just describe work:
```
/fleet fix the CSV parser crash and add a test
/fleet research why the dashboard query is slow
/fleet food-llm: tune the context window; api: add retry to the upload call
```
Each becomes a worker in its own pane + worktree. Detach with `Ctrl-b d` (agents keep
running); come back any time with `fleet attach`, or after a reboot with `fleet resume`.

## Using it from inside Claude — `/fleet`

`/fleet <prompt>` runs a **dispatch decision**: the manager picks the repo, **selects a skill**
(or none), **picks a mode** (once / loop / goal), and launches the worker — then tells you what
it chose. You can also be explicit:

```
/fleet <prompt>                       # manager auto-picks skill + mode
/fleet research <thing>               # force the read-only research skill
/fleet keep checking the deploy …     # → loop mode (recurring)
/fleet rm self                        # (inside a worker) remove me + my sub-workers
/fleet ls            /fleet status    /fleet sessions
```

## Command reference

### Sessions
```bash
fleet manager [dir] [--name X] [--window]   # open a manager (rooted at dir; default cwd)
                                            #   --window: new window in the CURRENT tmux session
fleet attach [--name X]                     # attach to a session
fleet status [session]                      # one-glance: manager + worker tree, live/saved
fleet sessions                              # list all sessions
fleet resume [session] [--dry-run]          # rebuild a session — manager + workers, conversations continued
fleet kill [--name X]                       # stop a session's tmux (keeps worktrees + state → resumable)
```
`--name` lets you run several independent managers (`billing`, `infra`, …) at once. Bare
`fleet resume` picks the most recently-active manager.

### Launch work
```bash
fleet add <repo> <task> "<prompt>|<file.md>" [base] [--skill NAME] [--no-worktree]
fleet research <repo> <task> "<issue|file.md>" [base]    # = --skill research (read-only)
```
`<repo>` can be a name (resolved under `PROJECTS_ROOT`), a path, or `.` for the current repo.
The prompt can be inline text **or a `.md` file path** (its contents become the task).
`--no-worktree` runs the worker in the repo itself (no branch) — handy for read-only research.

### Skills
```bash
fleet skill ls
fleet skill add <name> <file.md>            # register your own
fleet skill show <name>     fleet skill rm <name>
```
Built-ins: **research** (investigate, read-only), **review** (CodeRabbit-style review),
**fix** (review + apply + verify + commit). Apply any with `--skill <name>`.

### Clean up
```bash
fleet rm <repo> <task> [--branch] [--dry-run]   # remove a worker + every sub-worker it spawned
fleet rm --self [--branch]                       # (inside a worker) remove itself + its chain
fleet sessions rm <session> [--branch] [--dry-run]   # remove a session + ALL its child sessions
fleet prune [session] [--dry-run]                # drop recorded tasks whose worktree is gone
```
`kill` is reversible (keeps work for `resume`); `rm` / `sessions rm` are destructive — use
`--dry-run` to preview, `--branch` to also delete branches.

### PR review (`git` + `gh` + `jq`; open a pane, `--here` for foreground)
```bash
fleet pr sync     <pr>                       # checkout PR as pr/<num>, merge base, wire push
fleet pr review   <pr> [extra]               # CodeRabbit-style review agent
fleet pr fix      <pr> [extra]               # review-and-fix agent (commit & push)
fleet pr coverage <pr> [extra]               # fix the coverage gate
fleet pr merge    <pr> [--squash|--merge|--rebase] [--dry-run] [--summary-llm <tool>]
```
Run inside the target repo or pass `-C <repo-dir>`. `pr merge` defaults to `--squash` and
summarizes the body with `gemini` (use `--summary-llm none|claude` if you don't have it).
(The old top-level `fleet review/fix/…` still work but print a deprecation hint.)

### Setup / health
```bash
fleet install-claude     # (re)install the /fleet command
fleet doctor             # check tmux/gh/jq/claude/caffeinate + whether /fleet is installed
fleet help
```

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `FLEET_BACKEND` | auto (`tmux` if available, else `windows`) | Force the spawner backend |
| `FLEET_MODE` | `pane` | `window` = a tmux window per worker instead of a tiled pane |
| `PROJECTS_ROOT` | `~/Projects` | Where bare repo names resolve |
| `WT_ROOT` | `$PROJECTS_ROOT/.worktrees` | Where worktrees are created |
| `FLEET_SESSION` | `fleet` | Default session name |
| `FLEET_STATE_DIR` | `~/.fleet` | Where per-session state is stored |
| `FLEET_SKILLS_DIR` | `~/.fleet/skills` | Where your custom skills live |
| `FLEET_CLAUDE_FLAGS` | `--dangerously-skip-permissions` | Flags for each launched `claude` (set `""` to restore prompts) |
| `FLEET_NO_CAFFEINATE` | unset | macOS: `1` to skip the auto keep-awake while a session is alive |

> **Safety:** the default flags let agents run unattended (no permission prompts). Each worker
> is isolated in a throwaway worktree, but they share your real filesystem and credentials —
> only fan out tasks you'd trust to run on their own.

## License

MIT
