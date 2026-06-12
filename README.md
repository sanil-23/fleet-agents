# fleet-agents

Run multiple [Claude Code](https://claude.com/claude-code) agents in parallel — each in
its own isolated **git worktree**, each launched with its own task prompt. Orchestrate
them from one place, including from *inside* a Claude session via a `/fleet` slash command.

- **macOS / Linux / WSL** → agents run as panes in a single **tmux** session you can
  attach/detach (`fleet manager` gives you an orchestrator Claude; `/fleet` spawns workers).
- **Windows** → each agent opens in its own terminal window (no tmux required).

## Install

```bash
# from GitHub (works today)
npm install -g git+https://github.com/sanil-23/fleet-agents.git
# …or once published to npm:
# npm install -g fleet-agents

fleet install-claude             # adds the /fleet slash command to ~/.claude/commands
```

`fleet install-claude` writes to `~/.claude/commands/fleet.md` — the same location on every
OS (`%USERPROFILE%\.claude\commands` on Windows), resolved via Node's `os.homedir()`.

**Requires:** Node ≥ 16, `git`, and the `claude` CLI on your PATH. `tmux` on macOS/Linux
(Windows uses separate terminal windows). The PR review commands (`fleet review/fix/approve`)
also need `gh` + `jq`.

## Usage

```bash
fleet manager [dir] [--name X] [--window]        # orchestrator claude, rooted at dir (default: current dir)
                                                 #   --window: new window in the CURRENT tmux session (run from inside tmux)
fleet add <repo> <task> "<prompt>|<file.md>" [base]
fleet research <repo> <task> "<issue|file.md>" [base]   # read-only investigation agent (debug methodology)
                                                  #   add --no-worktree to run a pane in the repo itself (no branch)
fleet skill ls | add <name> <file.md> | rm <name> | show <name>   # reusable skill prompt templates
fleet add <repo> <task> "<prompt>" --skill <name>                 # prepend a skill to a task
fleet ls                                          # list active worktrees
fleet resume [repo] [--name X]                    # rebuild a session: manager pane + every worker, conversations continued
fleet sessions                                    # list all sessions (manager, tasks, live panes)
fleet sessions rm <session> [--branch]            # remove a session + ALL its child/sub-child sessions (kill + worktrees)
fleet rm  <repo> <task> [--branch]                # remove a worker + every sub-worker it spawned (chain)
fleet rm  --self [--branch]                        # …from inside a worker: remove itself + its chain
fleet attach                                      # re-attach to the tmux session
fleet kill                                        # tear down the session
fleet help
```

From inside a Claude session:

```
/fleet food-llm: fix the parser; patchtst-predictor: tune the context window
/fleet run tasks/migrate-db.md in food-llm
```

## PR review workflow

A bundled PR-number-based
review/fix/merge loop (agent-agnostic; default agent `claude`). Run inside the target
git repo, or pass `-C <repo-dir>`. Requires `git`, `gh`, `jq` (Unix / WSL only).

```bash
fleet sync     <pr>                 # checkout PR as pr/<num>, merge main, wire push remote
fleet review   <pr> [extra-prompt]  # sync + CodeRabbit-style review agent
fleet fix      <pr> [extra-prompt]  # sync + review-and-fix agent (commit & push)
fleet coverage <pr> [extra-prompt]  # sync + fix the coverage gate
fleet approve  <pr> [--squash|--merge|--rebase] [--dry-run] [--summary-llm <tool>]
                                    # gate 8 merge checks, then squash-merge via gh
```

- `approve` (alias `merge`) defaults to `--squash` and summarizes the squash body with
  `gemini`; if you don't have it, pass `--summary-llm none` or `--summary-llm claude`.
- These open in a new fleet tmux pane by default (like `fleet add`); add `--here` to run in the foreground.
- Pass-through env: `REVIEW_REPO`, `REVIEW_AGENT_SAFE`, `REVIEW_BANNED_COAUTHOR_RE` (see
  `review/README.md`).

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `FLEET_BACKEND` | auto (`tmux` if available, else `windows`) | Force the spawner backend |
| `FLEET_MODE` | `pane` | `window` = new tmux window per task instead of a tiled pane |
| `PROJECTS_ROOT` | `~/Projects` | Where bare repo names resolve |
| `WT_ROOT` | `$PROJECTS_ROOT/.worktrees` | Where worktrees are created |
| `FLEET_SESSION` | `fleet` | tmux session name |
| `FLEET_CLAUDE_FLAGS` | `--dangerously-skip-permissions` | Flags passed to each launched `claude` (set to `""` to restore prompts) |
| `FLEET_NO_CAFFEINATE` | unset | macOS: set to `1` to skip the auto `caffeinate` that keeps the Mac awake while a fleet session is alive (prevents idle-sleep from killing agents; auto-releases on `fleet kill`) |

> **Note:** the default flags let agents run unattended without permission prompts. Each
> agent is isolated in a throwaway worktree, but they share your real filesystem and
> credentials — only fan out tasks you'd trust to run on their own.

## License

MIT
