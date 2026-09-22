---
name: Context Tree Settings
description: Add, change, read, validate, or persist settings for the context-tree plugin. Use this whenever work touches the plugin's configuration — making something configurable, adding a build/run/test/port setting, wiring a value from opencode.json(c) into index.ts, tui.tsx, or model.ts, choosing between plugin options and storage, or debugging why a setting is ignored. Trigger even when the user only says "make X configurable", "put the command in config", "add a config flag", or "where do plugin settings live" without naming settings.
---

# Context Tree settings

There are two different things people call "settings" here, and mixing them up is
the main way this goes wrong. Decide which one you are touching before writing
code.

| Kind | Where the user writes it | How the plugin reads it | Use for |
| --- | --- | --- | --- |
| **Options** | `options` on the plugin entry in `opencode.json(c)` | `ctx.options` (server) / `ctx.options` (TUI) | Anything the user authors, reviews, and diffs: build/run/test commands, port ranges |
| **Storage** | Nowhere — the plugin owns it | `ctx.storage` (server) / `ctx.storage.store` (TUI) | Runtime state the plugin mutates: the node map, captured run state, caches |

Rule of thumb: if the user would want to see it in a diff and could edit it by
hand, it is an **option**. If the plugin writes it while running, it is
**storage**. Never store user-authored config in storage, and never try to make
runtime state an option — the user cannot change an option while a session runs.

## Options: one parser, one source of truth

Read `ctx.options` in exactly one place: `settings.ts` next to `index.ts`. Both
plugin entrypoints (`index.ts` for the server, `tui.tsx` for the TUI) load as
separate instances of the plugin, so if each parsed options itself they would
drift on defaults and validation. `settings.ts` gives them one normalized,
typed `Settings` object.

Copy `assets/settings.ts` as the starting point. It exports:

- `Settings` — the typed, fully-resolved shape. Everything downstream uses this,
  never the raw options.
- `DEFAULTS` — the fallback for every setting, so the plugin works with no config.
- `parseSettings(options)` — returns `{ settings, issues }`.

Two properties of `parseSettings` matter and are deliberate:

- **It never throws.** A typo in `opencode.json(c)` must not stop the plugin from
  loading — otherwise one bad character takes the whole tree offline. Instead it
  falls back to the default and records a `SettingsIssue`.
- **It treats options as untrusted.** `PluginOptions` is
  `Readonly<Record<string, any>>`; nothing validates it for you. Narrow every
  value (`typeof`, integer range, non-empty string) and ignore unknown keys so
  a newer config does not break an older plugin.

Surface issues rather than swallowing them: `tui.tsx` toasts them and `index.ts`
logs them. That is the only feedback loop the user has for a mistyped setting.

In `tui.tsx` parse once in `setup` and pass `settings` down (for example into
`loadTree(ctx, settings)`); do not re-parse inside `model.ts` or `tree.tsx`.

## The current settings surface

This is the agreed v1 surface. Extend it with the checklist below rather than
inventing parallel keys.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `commands.setup` | string | – | Run once when a node's worktree is created |
| `commands.build` | string | – | Build command for a node |
| `commands.test` | string | – | Test command for a node |
| `commands.run` | string | – | Long-running command that starts a node's service |
| `ports.base` | integer 1–65535 | `3000` | First port handed to a node |
| `ports.stride` | integer ≥ 1 | `10` | Ports reserved per node; node `n` gets the block starting at `base + n * stride` |

Commands are deliberately blank by default. The charter is explicit that config
"declares the build/run/test commands so the tool works on any project" and that
we "do not invent a parallel registry" — so never hardcode a project's commands
in source, and never add a second place commands can live. `ports` exists because
parallel nodes must not share runtime resources; a deterministic per-node block
is what makes that true without a runtime port manager.

## Configure it

`opencode.jsonc` at the repo root:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./.opencode/plugins/context-tree",
      "options": {
        "commands": { "build": "npm run build", "test": "npm test" },
        "ports": { "base": 4100, "stride": 5 }
      }
    }
  ]
}
```

Because this plugin lives under `.opencode/plugins/`, OpenCode discovers it on
its own and hands it empty options. The object-form entry above is how options
are supplied: when it was added, OpenCode reloaded the plugin with the options
instead of running a second copy. If you ever see doubled behavior (two toasts,
commands registered twice) after adding the entry, check the plugin manager
dialog before assuming the config itself is wrong.

Relative paths in `plugins` resolve from the config file that contains them.
Secrets belong in options as `{env:VAR}` substitution, never as literals.

## Add or change a setting

1. **Confirm it is an option, not storage.** Re-read the table at the top. If the
   plugin mutates it at runtime, go to the storage section instead.
2. Add the field to `Settings` and give it a default in `DEFAULTS` in
   `settings.ts`.
3. Narrow it in `parseSettings` and push a `SettingsIssue` when the value is
   wrong, keeping the default.
4. Consume it from the parsed `settings`, not from `ctx.options`.
5. Update the surface table above and the `opencode.jsonc` example if the shape
   changed. This skill is the map; an updated setting that is not listed here is
   how the next person misses it.
6. Run `npm run typecheck`.
7. Verify at runtime (below).

## Runtime state goes in storage

Server `index.ts` uses `ctx.storage`:

```ts
await ctx.storage.set("context-tree/nodes", nodeMap)      // durable JSON
const nodeMap = await ctx.storage.get("context-tree/nodes")
await ctx.storage.remove("context-tree/nodes")
const page = await ctx.storage.scan({ prefix: "context-tree/", limit: 100 })
```

The TUI uses `context.storage`. `store` is durable and stays live across running
TUI instances; `memory` is discarded when the TUI exits:

```ts
const [state, updateState] = ctx.storage.store("context-tree/ui", { initial: { collapsed: [] as string[] } })
await updateState((draft) => { draft.collapsed.push(id) })
```

Conventions:

- Prefix every key with `context-tree/` and keep one key per concern. The server
  and TUI share the same storage, so a prefix is what keeps another plugin's keys
  out and makes `scan` clean.
- Prefer `store` over `memory` unless the value is genuinely session-scoped;
  losing the node map on exit would be a bug.
- Storage holds state, not preferences. If the user should be able to set it,
  it is an option.
- Never store credentials.

## Verify

1. `npm run typecheck` — `settings.ts` is inside the tsconfig include, so this
   catches shape mistakes.
2. Reload the plugin: save a file under `.opencode/plugins/context-tree/` (the
   config dirs are watched) or run `opencode service restart` if a stale module
   cache is suspected.
3. Trigger a bad value on purpose and confirm the issue surfaces as a toast
   rather than a crash, then fix it.
4. Open the plugin manager dialog to confirm the plugin did not load twice.

## Supporting files

- `references/plugin-settings-api.md` — exact signatures and config semantics for
  `options` and storage in both entrypoints. Read it when you need the precise
  shape or are troubleshooting where a value comes from.
- `assets/settings.ts` — the canonical parser to copy when `settings.ts` does not
  exist yet.
