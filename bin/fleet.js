#!/usr/bin/env node
'use strict';

/*
 * fleet — run multiple Claude Code agents in parallel, each in its own git worktree.
 *
 * Backends:
 *   tmux     (default on macOS/Linux/WSL) — manager + worker panes in one session, attach/detach.
 *   windows  (default on Windows, or when tmux is absent) — each agent in its own OS terminal window.
 *
 * See `fleet help`.
 */

const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ----------------------------------------------------------------------------- config
const HOME = os.homedir();
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.join(HOME, 'Projects');
const WT_ROOT = process.env.WT_ROOT || path.join(PROJECTS_ROOT, '.worktrees');
let SESSION = process.env.FLEET_SESSION || 'fleet'; // overridable per-command via --name
const MODE = process.env.FLEET_MODE || 'pane'; // pane | window (tmux only)
// Flags handed to each launched `claude`. Default skips permission prompts so agents run
// unattended. Set FLEET_CLAUDE_FLAGS="" to restore prompts. (?? keeps an explicit "".)
const CLAUDE_FLAGS = process.env.FLEET_CLAUDE_FLAGS ?? '--dangerously-skip-permissions';

function die(msg) { console.error(`fleet: ${msg}`); process.exit(1); }
function have(bin) {
  try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function hasTmux() {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const BACKEND = process.env.FLEET_BACKEND ||
  (process.platform === 'win32' ? 'windows' : (hasTmux() ? 'tmux' : 'windows'));

// ----------------------------------------------------------------------------- helpers
function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', ...opts });
}
function gitQuiet(repo, args) {
  // capture stdout, swallow stderr (probes like show-ref print "not a valid ref")
  try {
    return execFileSync('git', ['-C', repo, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
function tmux(args, opts = {}) {
  const out = execFileSync('tmux', args, { encoding: 'utf8', ...opts });
  return out == null ? '' : out.trim();
}
function tmuxHas() {
  try { execFileSync('tmux', ['has-session', '-t', SESSION], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function tmuxHasName(name) {
  try { execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function resolveRepo(name) {
  const candidates = [name, path.join(PROJECTS_ROOT, name)];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, '.git'))) return path.resolve(c);
  }
  die(`no git repo found for '${name}' (looked in ./ and ${PROJECTS_ROOT}/)`);
}

function slug(s) {
  return s.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9._-]/g, '');
}

// Pull `--name <v>` / `-n <v>` out of an args array; returns [value|undefined, remainingArgs].
function takeFlag(args, names) {
  const rest = [];
  let val;
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) { val = args[i + 1]; i++; }
    else rest.push(args[i]);
  }
  return [val, rest];
}

// ----------------------------------------------------------------------------- session state
// Persist enough to rebuild a session after a reboot/kill: the manager's dir + its tasks.
// One JSON file per session under ~/.fleet (override with FLEET_STATE_DIR).
const STATE_DIR = process.env.FLEET_STATE_DIR || path.join(HOME, '.fleet');
const statePath = (session) => path.join(STATE_DIR, `${session}.json`);
function loadState(session) {
  try { return JSON.parse(fs.readFileSync(statePath(session), 'utf8')); }
  catch { return { session, managerDir: null, tasks: [] }; }
}
function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath(state.session), JSON.stringify(state, null, 2));
  } catch {}
}
// If this session was created from INSIDE another fleet session (env FLEET_SESSION differs),
// record that parent — so removing the parent can cascade to child/sub-child sessions.
function recordParent(session) {
  const env = process.env.FLEET_SESSION;
  if (!env || env === session) return;
  const s = loadState(session);
  if (!s.parent) { s.parent = env; saveState(s); }
}
function recordManagerDir(session, dir) {
  recordParent(session);
  const s = loadState(session); s.managerDir = dir; saveState(s);
}
function recordTask(session, repo, task, wt, opts = {}) {
  recordParent(session);
  const s = loadState(session);
  let entry = s.tasks.find((t) => t.repo === repo && t.task === task);
  if (!entry) { entry = { repo, task, wt }; s.tasks.push(entry); }
  // If spawned from inside a worker pane, FLEET_TASK identifies the parent worker.
  const parentTask = process.env.FLEET_TASK;
  if (parentTask && parentTask !== `${repo}/${task}`) entry.parent = parentTask;
  if (opts.paneId) entry.paneId = opts.paneId;       // for kill-by-pane (no-worktree workers share cwd)
  if (opts.noWorktree) entry.noWorktree = true;      // its wt is the repo — never remove it
  saveState(s);
}
// Drop a task from whichever session(s) recorded it (rm may run from a plain terminal).
function unrecordTaskEverywhere(repo, task) {
  if (!fs.existsSync(STATE_DIR)) return;
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (!f.endsWith('.json')) continue;
    const s = loadState(f.replace(/\.json$/, ''));
    const before = s.tasks.length;
    s.tasks = s.tasks.filter((t) => !(t.repo === repo && t.task === task));
    if (s.tasks.length !== before) saveState(s);
  }
}

// POSIX single-quote a string for a remote shell (used with tmux send-keys).
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Build the shell command string that launches claude with flags + prompt.
function claudeCmd(prompt) {
  const flags = CLAUDE_FLAGS.trim();
  return ['claude', flags, shq(prompt)].filter(Boolean).join(' ');
}

// Resolve the prompt arg: if it points at a readable file, load its contents.
function loadPrompt(arg) {
  if (arg && fs.existsSync(arg) && fs.statSync(arg).isFile()) {
    const text = fs.readFileSync(arg, 'utf8');
    if (!text.trim()) die(`task file is empty: ${arg}`);
    const lines = text.split('\n').length;
    console.log(`fleet: task loaded from ${arg} (${lines} lines)`);
    return text;
  }
  return arg;
}

// Create the worktree for a task; returns { repo, branch, wt, base, reponame }.
function makeWorktree(repoArg, taskArg, baseArg) {
  const repo = resolveRepo(repoArg);
  const task = slug(taskArg);
  if (!task) die('task name slugified to empty; use letters/numbers');
  const reponame = path.basename(repo);
  const branch = task;
  const wt = path.join(WT_ROOT, reponame, task);
  const base = baseArg || gitQuiet(repo, ['symbolic-ref', '--short', 'HEAD']) || 'HEAD';

  if (fs.existsSync(wt)) {
    console.log(`fleet: worktree already exists, reusing -> ${wt}`);
  } else {
    fs.mkdirSync(path.join(WT_ROOT, reponame), { recursive: true });
    const exists = gitQuiet(repo, ['show-ref', '--verify', `refs/heads/${branch}`]);
    if (exists) git(repo, ['worktree', 'add', wt, branch], { stdio: 'inherit' });
    else git(repo, ['worktree', 'add', '-b', branch, wt, base], { stdio: 'inherit' });
  }
  return { repo, branch, wt, base, reponame, task };
}

// ----------------------------------------------------------------------------- tmux backend
const tmuxBackend = {
  ensureSession(cwd = PROJECTS_ROOT) {
    if (tmuxHas()) return;
    tmux(['new-session', '-d', '-s', SESSION, '-c', cwd, '-n', 'home']);
    try { tmux(['set-option', '-t', SESSION, 'pane-border-status', 'top']); } catch {}
    // claude overwrites pane_title, so label borders by worktree folder (the task slug).
    try { tmux(['set-option', '-t', SESSION, 'pane-border-format', ' #{b:pane_current_path} ']); } catch {}
    // Stamp FLEET_SESSION into the session env so EVERY pane spawned in it (manager → worker
    // → sub-worker …) inherits it — so a worker that spawns its own worker still records under
    // and lands in THIS session, keeping the whole chain intact for resume.
    try { tmux(['set-environment', '-t', SESSION, 'FLEET_SESSION', SESSION]); } catch {}
    // macOS idle-sleeps on battery, which suspends agents and drops their API connections.
    // Hold a caffeinate assertion for the life of the tmux server so sleep can't kill them.
    // Opt out with FLEET_NO_CAFFEINATE=1.
    if (process.platform === 'darwin' && process.env.FLEET_NO_CAFFEINATE !== '1'
        && fs.existsSync('/usr/bin/caffeinate')) {
      try {
        const srvPid = tmux(['display-message', '-p', '#{pid}']);
        spawn('caffeinate', ['-i', '-m', '-s', '-w', srvPid], { detached: true, stdio: 'ignore' }).unref();
      } catch {}
    }
  },
  spawn({ wt, cmd, taskId }) {
    this.ensureSession();
    let pane;
    if (MODE === 'window') {
      pane = tmux(['new-window', '-P', '-F', '#{pane_id}', '-t', SESSION, '-c', wt, process.env.SHELL || '/bin/sh']);
    } else {
      pane = tmux(['split-window', '-P', '-F', '#{pane_id}', '-t', SESSION, '-c', wt, process.env.SHELL || '/bin/sh']);
      tmux(['select-layout', '-t', SESSION, 'tiled']);
    }
    // Prefix FLEET_SESSION (keeps the agent on this session) and FLEET_TASK (so a sub-worker
    // it spawns records THIS worker as its parent → removable as a chain).
    const env = [`FLEET_SESSION=${shq(SESSION)}`];
    if (taskId) env.push(`FLEET_TASK=${shq(taskId)}`);
    tmux(['send-keys', '-t', pane, `${env.join(' ')} ${cmd}`, 'Enter']);
    return pane;
  },
  // Launch the orchestrator claude in pane 0 (if it's an idle shell). cont=true continues
  // the manager's saved conversation. Exports FLEET_SESSION so its `fleet add`s target here.
  launchManager(cwd, cont = false) {
    const info = tmux(['list-panes', '-t', SESSION, '-F', '#{pane_id} #{pane_current_command}']).split('\n')[0];
    const sp = info.indexOf(' ');
    const pid = info.slice(0, sp), pcmd = info.slice(sp + 1);
    if (!/^-?(zsh|bash|sh|fish)$/.test(pcmd)) return false;
    const claudeArgs = ['claude', cont ? '--continue' : '', CLAUDE_FLAGS.trim()].filter(Boolean).join(' ');
    const launch = `cd ${shq(cwd)} && FLEET_SESSION=${shq(SESSION)} ` + claudeArgs;
    tmux(['send-keys', '-t', pid, launch, 'Enter']);
    return true;
  },
  manager({ cwd = PROJECTS_ROOT } = {}) {
    this.ensureSession(cwd);
    if (this.launchManager(cwd, false)) {
      // Only record the dir we ACTUALLY launched at — avoids drift when a manager is
      // already running (the live pane didn't move, so don't rewrite its recorded dir).
      recordManagerDir(SESSION, cwd);
      console.log(`fleet: manager started in session '${SESSION}' at ${cwd} (type /fleet inside it)`);
    } else {
      const cur = loadState(SESSION).managerDir;
      console.log(`fleet: manager already running in session '${SESSION}'${cur ? ` at ${cur}` : ''} (kept its dir)`);
    }
    this.attach();
  },
  // Open a manager as a NEW WINDOW in the CURRENT tmux session (must be run from inside tmux).
  // Its workers join that same session, so everything stays in one session as switchable windows.
  managerWindow(cwd) {
    const sess = tmux(['display-message', '-p', '#S']);
    try { tmux(['set-option', '-t', sess, 'pane-border-status', 'top']); } catch {}
    try { tmux(['set-option', '-t', sess, 'pane-border-format', ' #{b:pane_current_path} ']); } catch {}
    try { tmux(['set-environment', '-t', sess, 'FLEET_SESSION', sess]); } catch {}
    const pid = tmux(['new-window', '-P', '-F', '#{pane_id}', '-c', cwd,
      '-n', path.basename(cwd) || 'manager', process.env.SHELL || '/bin/sh']);
    const launch = `cd ${shq(cwd)} && FLEET_SESSION=${shq(sess)} ` +
      ['claude', CLAUDE_FLAGS.trim()].filter(Boolean).join(' ');
    tmux(['send-keys', '-t', pid, launch, 'Enter']);
    recordManagerDir(sess, cwd);
    console.log(`fleet: manager opened as a new window in session '${sess}' at ${cwd}`);
  },
  attach() {
    if (!tmuxHas()) die('no fleet session running (try: fleet manager)');
    const sub = process.env.TMUX ? 'switch-client' : 'attach';
    spawnSync('tmux', [sub, '-t', SESSION], { stdio: 'inherit' });
  },
  kill() {
    if (!tmuxHas()) { console.log('fleet: no session'); return; }
    execFileSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
    console.log('fleet: killed session');
  },
};

// ----------------------------------------------------------------------------- windows / separate-window backend
function openTerminal(wt, cmd) {
  const plat = process.platform;
  if (plat === 'win32') {
    // Prefer Windows Terminal; fall back to a classic console window.
    if (have('wt.exe') || have('wt')) {
      spawn('wt.exe', ['-w', '0', 'nt', '-d', wt, 'cmd', '/k', cmd], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', `cd /d "${wt}" && ${cmd}`], { detached: true, stdio: 'ignore' }).unref();
    }
  } else if (plat === 'darwin') {
    const script = `cd ${shq(wt)} && ${cmd}`;
    const osa = `tell application "Terminal" to do script ${shq(script)}`;
    spawn('osascript', ['-e', osa], { detached: true, stdio: 'ignore' }).unref();
  } else {
    // Linux: try common terminal emulators in order.
    const inner = `cd ${shq(wt)}; ${cmd}; exec ${process.env.SHELL || 'bash'}`;
    const terms = [
      ['x-terminal-emulator', ['-e', 'bash', '-lc', inner]],
      ['gnome-terminal', ['--', 'bash', '-lc', inner]],
      ['konsole', ['-e', 'bash', '-lc', inner]],
      ['xfce4-terminal', ['-e', `bash -lc ${shq(inner)}`]],
      ['xterm', ['-e', 'bash', '-lc', inner]],
    ];
    for (const [bin, args] of terms) {
      if (have(bin)) { spawn(bin, args, { detached: true, stdio: 'ignore' }).unref(); return; }
    }
    die('no supported terminal emulator found (install gnome-terminal/konsole/xterm, or use FLEET_BACKEND=tmux)');
  }
}

const windowsBackend = {
  spawn({ wt, cmd }) { openTerminal(wt, cmd); },
  manager({ cwd = PROJECTS_ROOT } = {}) {
    // No multiplexer: the manager just runs claude in the current terminal, rooted at cwd.
    recordManagerDir(SESSION, cwd);
    console.log(`fleet: launching manager in this terminal at ${cwd} — type /fleet inside it.`);
    const r = spawnSync('claude', CLAUDE_FLAGS.split(/\s+/).filter(Boolean),
      { stdio: 'inherit', shell: true, cwd });
    process.exit(r.status || 0);
  },
  attach() {
    console.log('fleet: separate-window backend has no shared session to attach to.');
    console.log('       Each agent runs in its own terminal window. Use `fleet ls` to see worktrees.');
  },
  kill() {
    console.log('fleet: separate-window backend — close the agent terminal windows manually.');
    console.log('       Use `fleet ls` / `fleet rm <repo> <task>` to clean up worktrees.');
  },
};

const backend = BACKEND === 'tmux' ? tmuxBackend : windowsBackend;

// ----------------------------------------------------------------------------- commands
// Shared task launcher: spawn the agent pane with the prompt. With noWorktree, it runs in
// the repo's own working tree (no branch/worktree, not recorded); otherwise it makes and
// records an isolated worktree.
function launchTask(repoArg, taskArg, prompt, baseArg, opts = {}) {
  const { kind, noWorktree } = opts;
  if (!have('claude')) die('claude not found on PATH');
  if (BACKEND === 'tmux' && !hasTmux()) die('tmux not found');
  const label = kind ? `[${kind}] ` : '';

  if (noWorktree) {
    const repo = resolveRepo(repoArg);
    const reponame = path.basename(repo);
    const task = slug(taskArg) || 'work';
    const paneId = backend.spawn({ wt: repo, cmd: claudeCmd(prompt), taskId: `${reponame}/${task}` });
    recordTask(SESSION, reponame, task, repo, { paneId, noWorktree: true });
    console.log(`fleet: launched ${label}[${reponame}/${task}] in repo (no worktree)`);
    if (BACKEND === 'tmux' && !process.env.TMUX) console.log('       attach:   fleet attach');
    return;
  }

  const { wt, branch, base, reponame, task } = makeWorktree(repoArg, taskArg, baseArg);
  const paneId = backend.spawn({ wt, cmd: claudeCmd(prompt), taskId: `${reponame}/${task}` });
  recordTask(SESSION, reponame, task, wt, { paneId });
  console.log(`fleet: launched ${label}[${reponame}/${task}]`);
  console.log(`       worktree: ${wt}`);
  console.log(`       branch:   ${branch} (base: ${base})`);
  if (BACKEND === 'tmux' && !process.env.TMUX) console.log('       attach:   fleet attach');
}

// Strip --no-worktree from args; returns [bool, remainingArgs].
function takeNoWorktree(args) {
  let no = false;
  const rest = args.filter((a) => ((a === '--no-worktree' || a === '-W') ? ((no = true), false) : true));
  return [no, rest];
}

function cmdAdd(args) {
  const [noWorktree, a1] = takeNoWorktree(args);
  const [skill, rest] = takeFlag(a1, ['--skill', '-k']);
  if (rest.length < 3) die('usage: fleet add <repo> <task> "<prompt>|<file.md>" [base] [--no-worktree] [--skill <name>]');
  const [repoArg, taskArg, promptArg, baseArg] = rest;
  let prompt = loadPrompt(promptArg);
  if (skill) prompt = applySkill(skill, prompt);
  launchTask(repoArg, taskArg, prompt, baseArg, { noWorktree, kind: skill || undefined });
}

// `fleet research …` is just the built-in 'research' skill (read-only debug methodology).
function cmdResearch(args) {
  cmdAdd([...args, '--skill', 'research']);
}

// ----------------------------------------------------------------------------- skills
// A "skill" is a named prompt template prepended to a task. Built-ins ship in prompts/;
// user skills live in ~/.fleet/skills/<name>.md (override dir with FLEET_SKILLS_DIR).
const SKILLS_DIR = process.env.FLEET_SKILLS_DIR || path.join(HOME, '.fleet', 'skills');
function skillPath(name) {
  const user = path.join(SKILLS_DIR, `${name}.md`);
  if (fs.existsSync(user)) return user;
  const builtin = path.join(__dirname, '..', 'prompts', `${name}.md`);
  if (fs.existsSync(builtin)) return builtin;
  return null;
}
function applySkill(name, prompt) {
  const p = skillPath(name);
  if (!p) die(`unknown skill '${name}' (see: fleet skill ls)`);
  return `${fs.readFileSync(p, 'utf8')}\n\n# Task\n\n${prompt}`;
}
function listSkills() {
  const read = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')); } catch { return []; } };
  return { builtins: read(path.join(__dirname, '..', 'prompts')), users: read(SKILLS_DIR) };
}

function cmdSkill(args) {
  const sub = args[0] || 'ls';
  if (sub === 'ls' || sub === 'list') {
    const { builtins, users } = listSkills();
    console.log('built-in skills:');
    builtins.forEach((s) => console.log(`  ${s}`));
    console.log('your skills:');
    if (users.length) users.forEach((s) => console.log(`  ${s}`));
    else console.log('  (none — register with: fleet skill add <name> <file.md>)');
    return;
  }
  if (sub === 'add') {
    const [name, file] = args.slice(1);
    if (!name || !file) die('usage: fleet skill add <name> <file.md>');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die(`no such file: ${file}`);
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const sname = slug(name);
    const dest = path.join(SKILLS_DIR, `${sname}.md`);
    fs.copyFileSync(path.resolve(file), dest);
    console.log(`fleet: registered skill '${sname}' -> ${dest}`);
    console.log(`       use it: fleet add <repo> <task> "<prompt>" --skill ${sname}   (or /fleet ${sname} <prompt>)`);
    return;
  }
  if (sub === 'rm' || sub === 'remove') {
    const name = args[1];
    if (!name) die('usage: fleet skill rm <name>');
    const p = path.join(SKILLS_DIR, `${name}.md`);
    if (!fs.existsSync(p)) die(`no user skill '${name}' (built-ins can't be removed)`);
    fs.unlinkSync(p);
    console.log(`fleet: removed skill '${name}'`);
    return;
  }
  if (sub === 'show' || sub === 'cat') {
    const name = args[1];
    if (!name) die('usage: fleet skill show <name>');
    const p = skillPath(name);
    if (!p) die(`unknown skill '${name}'`);
    process.stdout.write(fs.readFileSync(p, 'utf8'));
    return;
  }
  die(`unknown skill subcommand '${sub}' (ls | add | rm | show)`);
}

// List all fleet SESSIONS (the containers), with their manager (if any) + task/pane counts.
// A session may have no manager — managers are just pane 0 of a session, when present.
function cmdLsSessions() {
  if (!fs.existsSync(STATE_DIR)) { console.log('no fleet sessions recorded'); return; }
  const names = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  if (!names.length) { console.log('no fleet sessions recorded'); return; }
  console.log('  SESSION              STATE   MANAGER                TASKS  LIVE-PANES');
  for (const name of names.sort()) {
    const s = loadState(name);
    const live = BACKEND === 'tmux' && tmuxHasName(name);
    let panes = '';
    if (live) {
      try { panes = String(tmux(['list-panes', '-s', '-t', name, '-F', 'x']).split('\n').filter(Boolean).length); }
      catch { panes = '?'; }
    }
    const mgr = s.managerDir ? path.basename(s.managerDir) : '—';
    console.log(`  ${name.padEnd(20)} ${(live ? '● live' : '○ saved').padEnd(7)} ${mgr.padEnd(22)} ${String(s.tasks.length).padEnd(6)} ${live ? panes : '-'}`);
  }
}

// Remove a worktree by its path (resolve its main repo from the worktree itself).
function removeWorktreeByPath(wt, branch, delBranch) {
  if (!fs.existsSync(wt)) return;
  // SAFETY: only ever delete paths under WT_ROOT — never a real repo (e.g. a no-worktree
  // task's dir IS the repo root). This guards against catastrophic fs.rmSync on a repo.
  if (!path.resolve(wt).startsWith(path.resolve(WT_ROOT) + path.sep)) return;
  let mainRepo = null;
  try {
    const cd = execFileSync('git', ['-C', wt, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    mainRepo = path.dirname(path.resolve(wt, cd));
  } catch {}
  try {
    if (mainRepo) execFileSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    else fs.rmSync(wt, { recursive: true, force: true });
  } catch { try { fs.rmSync(wt, { recursive: true, force: true }); } catch {} }
  if (delBranch && mainRepo && branch) {
    try { execFileSync('git', ['-C', mainRepo, 'branch', '-D', branch], { stdio: 'ignore' }); } catch {}
  }
}

// Build parent → [children] from recorded session state.
function sessionChildrenMap() {
  const children = {};
  if (!fs.existsSync(STATE_DIR)) return children;
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (!f.endsWith('.json')) continue;
    const name = f.replace(/\.json$/, '');
    const p = loadState(name).parent;
    if (p) (children[p] = children[p] || []).push(name);
  }
  return children;
}

function removeOneSession(name, delBranch) {
  if (BACKEND === 'tmux') { try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {} }
  const s = loadState(name);
  for (const t of s.tasks) removeWorktreeByPath(t.wt, t.task, delBranch);
  try { fs.unlinkSync(statePath(name)); } catch {}
  console.log(`  removed session '${name}' — killed + ${s.tasks.length} worktree(s)${delBranch ? ' + branches' : ''}`);
}

// Remove a session by name AND every child/sub-child session it spawned.
function cmdRemoveSession(args) {
  const delBranch = args.includes('--branch');
  const dry = args.includes('--dry-run') || args.includes('-n');
  const name = args.find((a) => !a.startsWith('-'));
  if (!name) die('usage: fleet sessions rm <session> [--branch] [--dry-run]');
  const exists = fs.existsSync(statePath(name)) || (BACKEND === 'tmux' && tmuxHasName(name));
  if (!exists) die(`no session '${name}' (see: fleet sessions)`);

  // Collect the subtree (depth-first), then remove children before their parent.
  const children = sessionChildrenMap();
  const order = [];
  (function walk(n) { (children[n] || []).forEach(walk); order.push(n); })(name);

  if (dry) {
    console.log(`fleet: would remove session '${name}'${order.length > 1 ? ` + ${order.length - 1} descendant session(s)` : ''}:`);
    for (const s of order) console.log(`    - ${s} (${loadState(s).tasks.length} worktree(s))`);
    return;
  }
  console.log(`fleet: removing session '${name}'${order.length > 1 ? ` + ${order.length - 1} descendant session(s)` : ''}`);
  for (const s of order) removeOneSession(s, delBranch);
}

function cmdSessions(args) {
  const sub = args[0];
  if (sub === 'rm' || sub === 'remove') return cmdRemoveSession(args.slice(1));
  return cmdLsSessions();
}

// Set of currently-live tmux pane ids (for status).
function livePaneIds() {
  if (BACKEND !== 'tmux') return new Set();
  try { return new Set(tmux(['list-panes', '-a', '-F', '#{pane_id}']).split('\n').filter(Boolean)); }
  catch { return new Set(); }
}

// One-glance view of a session: manager + worker tree (with live/dead, no-worktree markers).
function cmdStatus(args) {
  const target = args.find((a) => !a.startsWith('-'))
    || process.env.FLEET_SESSION || mostRecentManagerSession() || SESSION;
  if (!fs.existsSync(statePath(target)) && !(BACKEND === 'tmux' && tmuxHasName(target))) {
    console.log(`fleet: no session '${target}' (see: fleet sessions)`);
    return;
  }
  const s = loadState(target);
  const live = BACKEND === 'tmux' && tmuxHasName(target);
  const panes = livePaneIds();
  console.log(`session: ${target}   [${live ? '● live' : '○ saved (resume to reopen)'}]`);
  console.log(`manager: ${s.managerDir || '(none)'}`);

  if (!s.tasks.length) { console.log('workers: (none)'); }
  else {
    console.log(`workers (${s.tasks.length}):`);
    const byParent = {};
    for (const t of s.tasks) (byParent[t.parent || ''] = byParent[t.parent || ''] || []).push(t);
    const walk = (parentId, depth) => {
      for (const t of byParent[parentId] || []) {
        const id = `${t.repo}/${t.task}`;
        const tags = [];
        if (t.noWorktree) tags.push('no-worktree');
        if (live && t.paneId) tags.push(panes.has(t.paneId) ? 'running' : 'pane closed');
        console.log(`  ${'  '.repeat(depth)}• ${id}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
        walk(id, depth + 1);
      }
    };
    walk('', 0);
  }

  const others = fs.existsSync(STATE_DIR)
    ? fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).filter((n) => n !== target)
    : [];
  if (others.length) console.log(`\nother sessions: ${others.join(', ')}   (fleet sessions)`);
}

// Check prerequisites and report.
function cmdDoctor() {
  const row = (label, ok, hint) => console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `   — ${hint}`}`);
  console.log('fleet doctor\n');
  row(`node ${process.version}`, true);
  row('git', have('git'), 'install git');
  row('claude CLI', have('claude'), 'install the Claude Code CLI and put it on PATH');
  if (process.platform !== 'win32') row('tmux', hasTmux(), 'install tmux, or set FLEET_BACKEND=windows');
  row('gh  (for fleet pr …)', have('gh'), 'install the GitHub CLI');
  row('jq  (for fleet pr …)', have('jq'), 'install jq');
  if (process.platform === 'darwin') row('caffeinate', fs.existsSync('/usr/bin/caffeinate'), 'built-in on macOS — unexpected if missing');
  row('/fleet command installed', fs.existsSync(path.join(HOME, '.claude', 'commands', 'fleet.md')), 'run: fleet install-claude');
  console.log(`\nbackend: ${BACKEND}   projects: ${PROJECTS_ROOT}   worktrees: ${WT_ROOT}   session: ${SESSION}`);
}

// PR review toolkit, namespaced: `fleet pr <sync|review|fix|coverage|merge> <pr> [...]`.
function cmdPr(args) {
  const sub = args[0];
  const map = { sync: 'sync.sh', review: 'review.sh', fix: 'fix.sh', coverage: 'coverage.sh', merge: 'merge.sh', approve: 'merge.sh' };
  if (!sub || !map[sub]) die('usage: fleet pr <sync|review|fix|coverage|merge> <pr> [extra]');
  cmdReview(map[sub], args.slice(1));
}

function cmdLs(args = []) {
  if (args.includes('--sessions') || args.includes('-s')) return cmdLsSessions();
  if (!fs.existsSync(WT_ROOT)) { console.log('no worktrees yet'); return; }
  let any = false;
  for (const repo of fs.readdirSync(WT_ROOT)) {
    const repoDir = path.join(WT_ROOT, repo);
    if (!fs.statSync(repoDir).isDirectory()) continue;
    for (const task of fs.readdirSync(repoDir)) {
      const wt = path.join(repoDir, task);
      if (!fs.existsSync(path.join(wt, '.git'))) continue;
      any = true;
      const br = gitQuiet(wt, ['symbolic-ref', '--short', 'HEAD']) || '?';
      const dirty = gitQuiet(wt, ['status', '--porcelain']).split('\n').filter(Boolean).length;
      console.log(`  ${(`${repo}/${task}`).padEnd(40)} ${br} (${dirty} changes)`);
    }
  }
  if (!any) console.log('no worktrees yet');
}

// Rebuild a whole session after a reboot/kill: the manager pane (its conversation continued)
// plus a worker pane per task — using recorded session state. claude saves history per
// directory, so `claude --continue` picks each agent up where it left off.
function cmdResume(args) {
  const dry = args.includes('--dry-run') || args.includes('-n');
  if (!have('claude')) die('claude not found on PATH');
  if (!dry && BACKEND === 'tmux' && !hasTmux()) die('tmux not found');

  const state = loadState(SESSION);
  // Prefer recorded tasks (faithful + session-scoped); fall back to scanning WT_ROOT for
  // legacy worktrees created before state tracking existed.
  let tasks = state.tasks.slice();
  if (!tasks.length && fs.existsSync(WT_ROOT)) {
    for (const repo of fs.readdirSync(WT_ROOT)) {
      const repoDir = path.join(WT_ROOT, repo);
      if (!fs.statSync(repoDir).isDirectory()) continue;
      for (const task of fs.readdirSync(repoDir)) {
        const wt = path.join(repoDir, task);
        if (fs.existsSync(path.join(wt, '.git'))) tasks.push({ repo, task, wt });
      }
    }
  }
  tasks = tasks.filter((t) => fs.existsSync(t.wt));

  if (!tasks.length && !state.managerDir) {
    console.log(`fleet: nothing to resume for session '${SESSION}'`);
    return;
  }

  if (dry) {
    console.log(`fleet: resume plan for session '${SESSION}'`);
    console.log(`  manager: ${state.managerDir || '(none)'}`);
    console.log(`  panes to restore (${tasks.length}):`);
    for (const t of tasks) console.log(`    - ${t.repo}/${t.task}`);
    return;
  }

  const cmd = ['claude', '--continue', CLAUDE_FLAGS.trim()].filter(Boolean).join(' ');

  if (BACKEND === 'tmux') {
    const managerDir = state.managerDir || PROJECTS_ROOT;
    tmuxBackend.ensureSession(managerDir);
    if (state.managerDir && tmuxBackend.launchManager(state.managerDir, true))
      console.log(`fleet: restored manager at ${state.managerDir}`);
    for (const t of tasks) {
      backend.spawn({ wt: t.wt, cmd });
      console.log(`fleet: resumed ${t.repo}/${t.task}`);
    }
    console.log(`fleet: session '${SESSION}' restored (${tasks.length} agent${tasks.length === 1 ? '' : 's'}) — fleet attach to watch`);
    tmuxBackend.attach();
  } else {
    for (const t of tasks) {
      backend.spawn({ wt: t.wt, cmd });
      console.log(`fleet: resumed ${t.repo}/${t.task}`);
    }
  }
}

// Drop recorded tasks whose worktree no longer exists (merged/removed), so session state
// stops accumulating. `fleet prune [session] [--dry-run]`.
function cmdPrune(args) {
  const dry = args.includes('--dry-run') || args.includes('-n');
  const target = args.find((a) => !a.startsWith('-'));
  if (!fs.existsSync(STATE_DIR)) { console.log('fleet: no state to prune'); return; }
  const files = fs.readdirSync(STATE_DIR)
    .filter((f) => f.endsWith('.json') && (!target || f === `${target}.json`));
  if (!files.length) { console.log(`fleet: no state for ${target || 'any session'}`); return; }

  let dropped = 0;
  for (const f of files.sort()) {
    const name = f.replace(/\.json$/, '');
    const s = loadState(name);
    const dead = s.tasks.filter((t) => !fs.existsSync(t.wt));
    if (!dead.length) continue;
    dropped += dead.length;
    console.log(`  ${name}: ${dry ? 'would drop' : 'dropped'} ${dead.length} stale (${s.tasks.length - dead.length} kept)`);
    for (const t of dead) console.log(`      - ${t.repo}/${t.task}`);
    if (!dry) { s.tasks = s.tasks.filter((t) => fs.existsSync(t.wt)); saveState(s); }
  }
  if (!dropped) console.log('fleet: nothing to prune (all recorded worktrees still exist)');
  else console.log(`fleet: ${dry ? 'would prune' : 'pruned'} ${dropped} stale task(s)${dry ? ' (run without --dry-run to apply)' : ''}`);
}

// Kill the tmux pane(s) whose cwd is this worktree.
function killPaneForWt(wt) {
  if (BACKEND !== 'tmux') return;
  try {
    for (const ln of tmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_current_path}']).split('\n')) {
      const i = ln.indexOf(' ');
      if (i > 0 && ln.slice(i + 1) === wt) tmux(['kill-pane', '-t', ln.slice(0, i)]);
    }
  } catch {}
}
// All recorded tasks across every session.
function allTasks() {
  const out = [];
  if (!fs.existsSync(STATE_DIR)) return out;
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (!f.endsWith('.json')) continue;
    for (const t of loadState(f.replace(/\.json$/, '')).tasks) out.push(t);
  }
  return out;
}
// Descendant tasks of <repo>/<task>, deepest-first (sub-workers before the worker).
function taskDescendants(rootId, tasks) {
  const byParent = {};
  for (const t of tasks) if (t.parent) (byParent[t.parent] = byParent[t.parent] || []).push(t);
  const out = [];
  (function walk(id) { (byParent[id] || []).forEach((c) => { walk(`${c.repo}/${c.task}`); out.push(c); }); })(rootId);
  return out;
}

// Close a worker's pane: by recorded pane id (robust for no-worktree workers that share the
// repo cwd), else by cwd for real worktrees (unique dirs). Never guesses by cwd for
// no-worktree workers — that would also match the manager.
function killPane(t) {
  if (BACKEND !== 'tmux') return;
  if (t.paneId) { try { tmux(['kill-pane', '-t', t.paneId]); return; } catch {} }
  if (!t.noWorktree) killPaneForWt(t.wt);
}

// Remove a worker AND every sub-worker it spawned (chain), closing panes + worktrees.
function cmdRm(args) {
  const delBranch = args.includes('--branch');
  const dry = args.includes('--dry-run') || args.includes('-n');
  const self = args.includes('--self');
  let reponame, task;
  if (self) {
    const id = process.env.FLEET_TASK;
    if (id && id.includes('/')) {
      reponame = id.slice(0, id.indexOf('/'));
      task = id.slice(id.indexOf('/') + 1);
    } else if (process.env.TMUX_PANE) {
      // No task identity, but we can still self-destruct the current pane.
      try { tmux(['kill-pane', '-t', process.env.TMUX_PANE]); } catch {}
      console.log('fleet: closed current worker pane (no FLEET_TASK — chain not resolved)');
      return;
    } else {
      die('--self requires being inside a fleet worker (FLEET_TASK / TMUX_PANE unset)');
    }
  } else {
    const pos = args.filter((a) => !a.startsWith('-'));
    if (pos.length < 2) die('usage: fleet rm <repo> <task> [--branch]   (or --self inside a worker)');
    reponame = path.basename(pos[0].replace(/\/+$/, ''));
    task = slug(pos[1]);
  }

  const rootId = `${reponame}/${task}`;
  const rootWt = path.join(WT_ROOT, reponame, task);
  const tasks = allTasks();
  const recordedRoot = tasks.find((t) => `${t.repo}/${t.task}` === rootId);
  const rootEntry = recordedRoot || { repo: reponame, task, wt: rootWt };
  // For --self, fall back to the live pane id if state didn't record one.
  if (self && !rootEntry.paneId && process.env.TMUX_PANE) rootEntry.paneId = process.env.TMUX_PANE;
  const descendants = taskDescendants(rootId, tasks); // deepest-first
  if (!recordedRoot && !fs.existsSync(rootWt) && !descendants.length && !rootEntry.paneId)
    die(`no worktree or recorded worker for ${rootId}`);

  const targets = [...descendants, rootEntry]; // children first, root last
  if (dry) {
    console.log(`fleet: would remove ${targets.length} worker(s)${descendants.length ? ` (incl. ${descendants.length} sub-worker(s))` : ''}${delBranch ? ' + branches' : ''}:`);
    for (const t of targets) console.log(`    - ${t.repo}/${t.task}${t.noWorktree ? ' (pane only)' : ''}`);
    return;
  }
  for (const t of targets) {
    // Clean up state + worktree BEFORE killing the pane — for `--self`, killing our own pane
    // terminates this process, so the cleanup must already be done by then.
    if (!t.noWorktree) removeWorktreeByPath(t.wt, t.task, delBranch);
    unrecordTaskEverywhere(t.repo, t.task);
    console.log(`  removed ${t.repo}/${t.task}${t.noWorktree ? ' (pane only)' : ''}`);
    killPane(t);
  }
  console.log(`fleet: removed ${targets.length} worker(s)${descendants.length ? ` (incl. ${descendants.length} sub-worker(s))` : ''}${delBranch ? ' + branches' : ''}`);
}

function cmdInstallClaude() {
  const dir = path.join(HOME, '.claude', 'commands');
  const src = path.join(__dirname, '..', 'commands', 'fleet.md');
  if (!fs.existsSync(src)) die(`bundled command file missing: ${src}`);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'fleet.md');
  fs.copyFileSync(src, dest);
  console.log(`fleet: installed /fleet command -> ${dest}`);
  console.log('       Open Claude Code and type /fleet to use it.');
}

// ----------------------------------------------------------------------------- review family
// Faithful wrappers around the bundled PR review toolkit (review/*.sh).
// They operate on a PR number in a real git repo (gh + jq + bash required).
//   sync     <pr>                    checkout PR as pr/<num>, merge main, wire push remote
//   review   <pr> [extra]            sync + CodeRabbit-style review agent
//   fix      <pr> [extra]            sync + review-and-fix agent (commit & push)
//   coverage <pr> [extra]            sync + fix the coverage gate
//   approve/merge <pr> [merge-flags] gate 8 checks + squash-merge via gh
function cmdReview(scriptName, args) {
  // -C/--repo <dir> chooses the repo working tree (default: cwd). By default these open a
  // new tmux pane (like `fleet add`); `--here`/`--fg` runs in the foreground instead.
  // Everything else passes through to the bundled script verbatim.
  let [dir, rest] = takeFlag(args, ['-C', '--repo']);
  let foreground = false;
  rest = rest.filter((a) => {
    if (a === '--here' || a === '--fg' || a === '--foreground') { foreground = true; return false; }
    if (a === '--pane') return false; // accepted for back-compat; pane is now the default
    return true;
  });

  const cwd = dir ? path.resolve(dir) : process.cwd();
  if (process.platform === 'win32')
    die('the review workflow needs bash + gh + jq — run it under WSL on Windows');
  if (!fs.existsSync(path.join(cwd, '.git')))
    die(`not a git repo: ${cwd} (run inside the repo, or pass -C <repo-dir>)`);
  for (const t of ['bash', 'gh', 'jq', 'git'])
    if (!have(t)) die(`missing required tool: ${t}`);

  const script = path.join(__dirname, '..', 'review', scriptName);
  if (!fs.existsSync(script)) die(`bundled review script missing: ${script}`);

  // sync/review/fix/coverage check out the PR — run them in a dedicated review worktree so
  // the primary checkout is never touched (and reviews can run in parallel). merge.sh never
  // checks out, so it skips this.
  const usesSync = ['sync.sh', 'review.sh', 'fix.sh', 'coverage.sh'].includes(scriptName);
  const pr = rest.find((a) => /^\d+$/.test(a));
  const wtEnv = {};
  if (usesSync && pr) {
    wtEnv.REVIEW_WORKTREE = '1';
    wtEnv.REVIEW_WT_DIR = path.join(WT_ROOT, path.basename(cwd), `pr-${pr}`);
  }

  const inPane = !foreground && BACKEND === 'tmux';
  if (inPane) {
    tmuxBackend.ensureSession(cwd);
    const envPrefix = Object.entries(wtEnv).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
    const cmd = [envPrefix, 'bash', shq(script), ...rest.map(shq)].filter(Boolean).join(' ');
    const pid = tmux(['split-window', '-P', '-F', '#{pane_id}', '-t', SESSION, '-c', cwd,
      process.env.SHELL || '/bin/sh']);
    tmux(['select-layout', '-t', SESSION, 'tiled']);
    tmux(['send-keys', '-t', pid, cmd, 'Enter']);
    const name = scriptName.replace('.sh', '');
    const where = wtEnv.REVIEW_WT_DIR ? ` (worktree: ${path.basename(wtEnv.REVIEW_WT_DIR)})` : '';
    console.log(`fleet: ${name} ${rest[0] || ''} running in a pane${where} — fleet attach to watch`);
  } else {
    const r = spawnSync('bash', [script, ...rest], { cwd, stdio: 'inherit', env: { ...process.env, ...wtEnv } });
    process.exit(r.status == null ? 1 : r.status);
  }
}

const HELP = `fleet — run multiple Claude Code agents in parallel, each in its own git worktree.

Backend: ${BACKEND}${BACKEND === 'tmux' ? ' (manager + worker panes in one tmux session)' : ' (each agent in its own terminal window)'}

SESSIONS  (a tmux session = a manager + its worker panes)
  fleet manager [dir] [--name X] [--window]   open an orchestrator claude (rooted at dir; default cwd)
                                              --window: new window in the CURRENT tmux session
  fleet attach [--name X]                     attach to a session
  fleet status [session]                      one-glance view: manager + worker tree, live/saved
  fleet sessions                              list all sessions (manager, tasks, live panes)
  fleet resume [session] [--dry-run]          rebuild a session (manager + workers, conversations continued)
  fleet kill [--name X]                       stop a session's tmux (keeps worktrees + state → resumable)

LAUNCH WORK  (spawns a worker pane in its own worktree)
  fleet add <repo> <task> "<prompt>|<file.md>" [base] [--skill NAME] [--no-worktree]
  fleet research <repo> <task> "<issue|file.md>" [base]   read-only investigation (= --skill research)
      ( default repo '.' = current repo. --no-worktree runs in the repo itself, no branch. )

SKILLS  (named prompt templates the worker is seeded with)
  fleet skill ls | add <name> <file.md> | rm <name> | show <name>

CLEAN UP
  fleet rm <repo> <task> [--branch] [--dry-run]   remove a worker + every sub-worker it spawned
  fleet rm --self [--branch]                       (inside a worker) remove itself + its chain
  fleet sessions rm <session> [--branch] [--dry-run]   remove a session + ALL child sessions
  fleet prune [session] [--dry-run]                drop recorded tasks whose worktree is gone

PR REVIEW  (needs git + gh + jq; run in the repo or pass -C <repo>; open a pane, --here for foreground)
  fleet pr sync     <pr>                       checkout PR as pr/<num>, merge base, wire push
  fleet pr review   <pr> [extra]               CodeRabbit-style review agent
  fleet pr fix      <pr> [extra]               review-and-fix agent (commit & push)
  fleet pr coverage <pr> [extra]               fix the coverage gate
  fleet pr merge    <pr> [--squash|--merge|--rebase] [--dry-run] [--summary-llm <tool>]

SETUP
  fleet install-claude                         install the /fleet slash command for Claude Code
  fleet doctor                                 check prerequisites (tmux/gh/jq/claude/…)
  fleet help

From inside Claude:  /fleet <prompt>   — the manager picks a skill + a mode (once/loop/goal) and dispatches.

Examples:
  fleet manager ~/code/myapp
  fleet add . fix-parser "Fix the CSV parser crash and add a test"
  fleet add . migrate ./tasks/migrate-db.md
  fleet research . why-slow "trace why the dashboard query is slow" --no-worktree

Env:
  FLEET_BACKEND       tmux | windows                  (default: auto — tmux if available, else windows)
  FLEET_MODE=window   new window per task vs tiled pane (tmux only)
  PROJECTS_ROOT       parent dir of your repos         (default: ~/Projects)
  WT_ROOT             where worktrees live             (default: $PROJECTS_ROOT/.worktrees)
  FLEET_SESSION       tmux session name                (default: fleet)
  FLEET_CLAUDE_FLAGS  flags for launched claude        (default: --dangerously-skip-permissions)
  FLEET_NO_CAFFEINATE=1  don't hold a macOS caffeinate assertion while the session is alive`;


// ----------------------------------------------------------------------------- dispatch
const SESSION_CMDS = new Set(['manager', 'up', 'add', 'research', 'investigate', 'attach', 'kill']);

// Pick the most recently active MANAGER session: prefer one that's currently live, else the
// most-recently-updated session that has a managerDir. Returns a session name or null.
function mostRecentManagerSession() {
  if (!fs.existsSync(STATE_DIR)) return null;
  const files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    const p = path.join(STATE_DIR, f);
    let managerDir = null;
    try { managerDir = JSON.parse(fs.readFileSync(p, 'utf8')).managerDir; } catch {}
    return { name: f.replace(/\.json$/, ''), mtime: fs.statSync(p).mtimeMs, managerDir };
  });
  const managers = files.filter((x) => x.managerDir);
  const pool = managers.length ? managers : files;
  if (!pool.length) return null;
  const live = pool.filter((x) => BACKEND === 'tmux' && tmuxHasName(x.name));
  return (live.length ? live : pool).sort((a, b) => b.mtime - a.mtime)[0].name;
}

function main() {
  let [cmd, ...rest] = process.argv.slice(2);
  // `--name`/`-n` overrides the session — but ONLY for session-scoped commands, so it
  // doesn't clash with review-family flags (e.g. merge.sh's `-n` = --dry-run).
  if (SESSION_CMDS.has(cmd)) {
    const [v, r] = takeFlag(rest, ['--name', '-n']);
    rest = r; if (v) SESSION = v;
  }

  switch (cmd) {
    case 'manager':
    case 'up': {
      // `fleet manager [--dir/-d <path>] [<path>] [--name X] [--window]` — root at a dir.
      // Default dir: where fleet was invoked. --window opens it as a new window in the
      // current tmux session instead of its own session.
      let [d, r] = takeFlag(rest, ['--dir', '-d']);
      let windowMode = false;
      r = r.filter((a) => ((a === '--window' || a === '-w') ? ((windowMode = true), false) : true));
      if (!d && r[0] && !r[0].startsWith('-')) d = r[0];
      const cwd = d ? path.resolve(d) : process.cwd();
      if (!fs.existsSync(cwd)) die(`manager dir does not exist: ${cwd}`);
      if (windowMode) {
        if (BACKEND !== 'tmux') die('--window requires the tmux backend');
        if (!process.env.TMUX) die('--window must be run from inside tmux (it adds a window to the current session)');
        tmuxBackend.managerWindow(cwd);
      } else {
        backend.manager({ cwd }); // records managerDir only when it actually launches (no drift)
      }
      break;
    }
    case 'add': cmdAdd(rest); break;
    case 'research':
    case 'investigate': cmdResearch(rest); break;
    case 'ls':
    case 'list': cmdLs(rest); break;
    case 'sessions': cmdSessions(rest); break;
    case 'prune': cmdPrune(rest); break;
    case 'skill':
    case 'skills': cmdSkill(rest); break;
    case 'resume':
    case 'restore': {
      // Target session: --name > positional <session> > most recently active manager.
      let [nm, r] = takeFlag(rest, ['--name', '-n']);
      const positional = r.find((a) => !a.startsWith('-'));
      const target = nm || positional || mostRecentManagerSession();
      if (!target) { console.log('fleet: no recorded manager sessions to resume'); break; }
      if (!nm && !positional) console.log(`fleet: resuming most recently active manager → '${target}'`);
      SESSION = target;
      cmdResume(r);
      break;
    }
    case 'rm':
    case 'remove': cmdRm(rest); break;
    case 'attach': backend.attach(); break;
    case 'kill': backend.kill(); break;
    case 'pr': cmdPr(rest); break;
    // deprecated top-level PR commands — prefer `fleet pr <cmd>`
    case 'sync':
    case 'review':
    case 'fix':
    case 'coverage':
    case 'approve':
    case 'merge':
      console.error(`fleet: '${cmd}' is now 'fleet pr ${cmd === 'approve' ? 'merge' : cmd}' (running anyway)`);
      cmdPr([cmd, ...rest]); break;
    case 'status': cmdStatus(rest); break;
    case 'doctor': cmdDoctor(); break;
    case 'install-claude': cmdInstallClaude(); break;
    case undefined:
    case 'help':
    case '-h':
    case '--help': console.log(HELP); break;
    default: die(`unknown command '${cmd}' (try: fleet help)`);
  }
}

main();
