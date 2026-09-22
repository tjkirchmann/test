# Context Tree

Project context and build plan. Read this before doing anything in this repo.

## What we are building

An **OpenCode 2.0 plugin** that turns parallel agent work on one feature branch
into a single navigable tree. Each node fuses three things so they can be seen
and driven together:

- **Context** — a forked session (contiguous line of thought).
- **Code** — a git branch + worktree, stacked off its parent.
- **Run** — that node's processes/services, with live status.

The tree renders as a graph in the TUI. Selecting a node is "which session,
worktree, and test server am I looking at".

The repo is named `opencode-context-tree`, which is now accurate.

## The problem

- Running several agents in parallel clobbers things: the working tree, and
  runtime resources (ports, save files, databases, test servers).
- Git worktrees fix the working-tree clobbering; the user wants that automated
  and legible.
- The user wants to *see* what is running and what is finished, and to dive
  through a tree of adjacent features while staying in one contiguous line of
  thought from a single base branch.

## Decisions (locked — do not relitigate without the user)

- **Node = fused**: a session plus its own branch/worktree.
- **Topology = stacked**: a child branch is created off its parent branch, not
  off a single flat base.
- **Merge = bottom-up `--no-ff` merges into the feature branch**, parents
  before children. Because branches are stacked, merging a parent first makes
  the child's delta clean. Cherry-pick is the exception, not the default.
- **Restack** a subtree with `git rebase --update-refs`.
- **Cherry-pick is opt-in and always uses `-x`** (records provenance). Reserve
  it for surgical backports.
- **Tag every node tip** under `refs/tree/<node>` so the tree is permanently
  auditable even if history later linearizes.
- **Enable `git rerere`** so repeated conflicts resolve once.
- **Worktree timing: create at node creation.** (This revises an earlier "lazy,
  on first write" decision: a session's working directory is fixed at creation,
  so promoting a node later means re-rooting or restarting its session, which
  breaks context contiguity.)
- **Config is project-agnostic and authored by the user.** It declares the
  build/run/test commands so the tool works on any project. No external runtime
  manager (eve or similar). The config is the source of truth for how to build,
  run, and test — do not invent a parallel registry.
- **Interaction is directional vim bindings only**: `h j k l` for movement,
  plus `gg`/`G`, `Enter`, `Esc`. No modal editor, no text editing, no vim
  emulation beyond movement.
- **UI uses the harness's own primitives and theme.** Do not hand-draw chrome,
  and do not build a separate external TUI app unless the harness genuinely
  cannot render the surface.
- **Runtime uses the harness's own process/tool execution.** Track per-node run
  state (running / finished-ok / failed / stopped) and show it on the node. Do
  not build a bespoke process supervisor if the harness provides one.

## Non-goals

- Not a vim editor; not modal text editing.
- Not a port manager or process supervisor built from scratch.
- Not a general stacked-PR review tool.
- Do not reimplement anything the harness already provides — check first.

## Hard constraints

- Git operations must be **abortable** and must **never auto-push**.
- Automated merges are a data-loss surface: keep node tags, log every git
  operation, keep each step reversible.
- Parallel nodes must not share mutable runtime resources (ports, save files,
  databases). Git isolation alone does not solve this; it is the real
  clobbering problem.
- The user keeps all history: never squash or discard commits unless explicitly
  asked.

## Harness mapping (OpenCode 2.0)

Target the V2 line: `@opencode/cli` 2.x and plugin SDK `@opencode/plugin` 2.x.
On this machine the V2 CLI is the Homebrew install (`/opt/homebrew/bin/opencode`,
currently 2.0.12). The `~/.opencode/bin/opencode` binary is stale V1 — do not
use it. Plugins are discovered from `.opencode/plugins/<id>/`, which must have a
server entrypoint `index.ts` and may have a TUI entrypoint `tui.tsx`.

- **Session (context)** → `session.list|get`, `Session.Info.parentID`, and
  `POST /session/{id}/fork` (`fork.sessionID` + boundary). Subagent sessions are
  ordinary children via `parentID`.
- **Worktree/branch (code)** → `worktree.list|create|remove|refresh` (Git
  strategy), `project.sandboxes`, and `vcs.get()`'s `branch.current` for the
  branch at a directory. A session's worktree is its
  `location.directory`.
- **Run state** → `shell.list` (running shells only), `session.active`, and the
  TUI cache `data.session.status(id)` (`"idle" | "running"`).
- **UI** → TUI plugin surfaces: `ui.router` routes, `ui.slot`, `session.panel`,
  `keymap.layer`, dialogs, toasts, and `theme` tokens. Use these; no hand-drawn
  chrome.
- **Node tags** → `refs/tree/<node>` are ours; the harness has no equivalent.

Data reality to keep in mind: many sessions can share one worktree; a session's
worktree directory is fixed at creation; `worktree.list` is saved inventory and
can be stale (union it with session directories and `project.sandboxes`); and
`shell.list` drops exited commands, so finished/failed states are not directly
observable yet.

## First milestone (smallest useful thing)

Prove the plugin loads and renders a graph-shaped surface over real state:

1. Read the session tree and the current worktrees.
2. Render them as a navigable tree with the directional keys.
3. Show per-node run state.

Read-only. No create, no merge, no worktree mutation yet.

Agreed shape for this milestone:

- **Node = worktree/branch** (the stacked unit). Sessions hang off the node that
  owns their directory; subagent sessions nest under their parent session.
- **Scope = current project only** (`ctx.location`).
- **Surface = a route page**, opened by the `/tree` command.
- The **root node** is the project's canonical checkout; other nodes are its
  worktrees/sandboxes and any directory a session runs in.

## Then

- Create a child node: fork the session, create a stacked branch/worktree off
  the parent, run the config's setup/build command.
- Start/stop the node's services; choose which node's test server you are on.
- Merge back: bottom-up merges, subtree restack, opt-in cherry-pick, node tags,
  conflict state shown on nodes.
- Persist the node map (session ↔ branch ↔ worktree ↔ run state).

## Status

Milestone 1 is implemented and loads in a fresh OpenCode 2.0 process. The plugin
lives at `.opencode/plugins/context-tree/` (`index.ts` server entry, `tui.tsx`
route, `model.ts` read-only assembly, `tree.tsx` view + navigation). It is a
concatenation-free, read-only tree of the current project's worktrees and
sessions with run state and directional navigation.

Known operational caveat: the long-running shared background service may hold a
stale module-resolution cache if it started before this repo's `node_modules`
existed; `opencode service restart` clears it. The plugin resolves normally in a
fresh process (`--standalone`).

## Open questions

- Where node metadata lives: harness storage vs an in-repo file. Candidates:
  OpenCode session `metadata`, the plugin's `ctx.storage`, or a committed file.
- How run state is discovered. The shell API only exposes *running* commands, so
  finished-ok / failed / stopped needs a server plugin capturing shell events
  into `ctx.storage` (or a status command declared in the config).
- How to derive branch stacking (parent branch per node) before we record it —
  git reflog/merge-base heuristics, or our own persisted graph.
