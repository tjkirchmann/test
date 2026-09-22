# Context Tree

Project context and build plan. Read this before doing anything in this repo.

## What we are building

A **read-only OpenCode 2.0 plugin that draws the context of the current session
as a family tree**. A session is one lane of contiguous thought; forks branch
that lane at the exact message where context diverged; subagent sessions fold
into the turn of their parent that spawned them. The plugin renders the active
lane as sequential, bordered boxes (one per turn, message, or step) with a
family rail for navigating between branches.

It is a **viewer**. It does not create, fork, merge, or mutate anything.

## The problem

A long agent run is hard to see. The transcript is a wall of text; the
interesting structure — which prompts produced which work, how much was tools
versus reply, where a fork split off, what a subagent actually did — is buried.
The user wants to *see* the shape of the context: box after box of turn
summaries, with branches visible as branches rather than indentation.

An earlier version of this plugin was an orchestrator (nodes = session + git
branch + worktree + run state). That direction is **out of scope** and has been
deleted. This repo is now only the context viewer.

## Decisions (locked — do not relitigate without the user)

- **A lane is a session.** One contiguous line of context.
- **Forks are branches, subagents are attachments.** A session is a *fork* when
  `Session.Info.fork` is set (it carries the parent's boundary message); it is a
  *subagent* when it has `parentID` but no `fork`. Subagents belong to the turn
  of their parent that spawned them, not to a sibling lane.
- **Branches attach at a real point, not a depth.** Fork junctions are placed at
  the boundary message (`fork.boundary.messageID`, `before`/`through`) in the
  parent's card list.
- **One lane on screen at a time, with a family rail.** The header shows the
  ancestry chain (root → … → active) and the active lane's child branches.
  `h`/`l` move between lanes; fork junctions inside a lane are jumpable.
- **Three view modes**, cycled with `m`: `turn` (user prompt + following work),
  `message` (one raw message per box), `step` (assistant content split into
  text / reasoning / grouped tool batches).
- **Summaries are heuristic. No LLM.** Titles and previews come from message
  text and metadata (tool counts, files, duration, tokens, cost); `Enter`
  expands to the raw content.
- **Boxes, not indentation.** Bordered cards in a vertical column with a rail
  gutter and connector junctions. This is a tree diagram, not a nested list.
- **Reactive data, not one-shot fetch.** Read `ctx.data.session.*` so the view
  updates live while a session runs.
- **Read-only.** No prompt injection, no git, no process management.
- **UI uses the harness's own primitives and theme.** No hand-drawn chrome.

## Non-goals

- Worktrees, stacked branches, merges, cherry-picks, node tags, run/shell state.
- Creating or forking sessions, or editing anything.
- LLM-generated summaries.
- A general session manager or a stacked-PR tool.
- Do not reimplement anything the harness already provides — check first.

## Harness mapping (OpenCode 2.0)

Target the V2 line: `@opencode/cli` 2.x and plugin SDK `@opencode/plugin` 2.x.
On this machine the V2 CLI is the Homebrew install (`/opt/homebrew/bin/opencode`,
v2.0.12). The bare `opencode` on `PATH` resolves to `~/.opencode/bin/opencode`,
which is **stale V1 — do not use it**; always call the absolute V2 path. Plugins
are discovered from `.opencode/plugins/<id>/`, which must have a server
entrypoint `index.ts` and may have a TUI entrypoint `tui.tsx`.

- **Sessions / lanes** → `data.session.list()`, `data.session.get(id)`,
  `data.session.root(id)` (walk to the family root), `data.session.family(id)`
  (all sessions sharing a root). `Session.Info.parentID` + `Session.Info.fork`
  (`{ sessionID, boundary: { type: "before"|"through", messageID } }`)
  distinguish forks from subagents.
- **Turns / messages** → `data.session.message.list(id)` (reactive),
  `.get(id, messageID)`, `.sync(id)`. `SessionMessageInfo` is a tagged union:
  `user`, `assistant` (with `content[]` of text / reasoning / tool, plus
  `agent`, `model`, `tokens`, `cost`, `snapshot.files`, `finish`, `error`),
  `shell`, `compaction`, `system`, `synthetic`, `skill`, `idle`, and the
  `agent-switched` / `model-switched` / `location-switched` markers.
- **Run state** → `data.session.status(id)` returns `"idle" | "running"`.
- **Live updates** → `data.on(type, handler)`; the `data.session.*` reads are
  already reactive inside a Solid computation.
- **UI** → `ui.router.register` / `navigate` (a route page opened by `/tree`),
  `ui.slot`, `keymap.layer`, `ui.toast`, and `theme` tokens. Use these; no
  hand-drawn chrome.

## Shape

- `index.ts` — server entrypoint, intentionally a no-op (read-only plugin).
- `tui.tsx` — registers the `context-tree` route and the global `/tree` command;
  passes `back` and `sessionID` as route data.
- `model.ts` — reads the family, groups messages into cards for each view mode,
  attaches branches at boundaries and subagents at their spawning turn.
- `tree.tsx` — the route view: family header, windowed box column, keymap.

## Status

Rewritten to the family-tree viewer. `model.ts` and `tree.tsx` replace the old
worktree/session tree. Verified: `npm run typecheck` is clean, the model was
exercised against a fixture (fork branch placed at its boundary message,
subagent attached to its turn, all three modes grouping correctly), and the TUI
entrypoint loads in a real V2 process with no errors or warnings.

Known operational caveat: a long-running shared background service may hold a
stale module-resolution cache if it started before this repo's `node_modules`
existed; `opencode service restart` clears it. The plugin resolves normally in a
fresh process.

## Open questions

- Matching a subagent to its spawning tool call: we currently attach by
  `time.created` against the parent's timeline. If the spawning tool call's
  `state.metadata` carries the child session id, prefer that.
- Whether to add a session family picker, so `/tree` can open a family other than
  the current one.
- Richer per-card rendering (diffs, syntax-highlighted tool output, inline
  markdown) versus the current pre-truncated plain lines.
- Persisting expansion/lane/mode selection across reloads via `ctx.storage`.
