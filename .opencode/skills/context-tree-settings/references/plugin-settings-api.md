# Plugin settings and storage API

Reference for the two channels context-tree uses. This is a summary of the
OpenCode V2 plugin API; when something here disagrees with the live docs, the docs
win: <https://opencode.ai/v2/docs/build/plugins> and
<https://opencode.ai/v2/docs/build/plugins/cli>.

## Options

User-authored values, supplied on the plugin entry in `opencode.json(c)`.

### Config shape

An entry in the `plugins` array is either a string (an enablement directive,
`-` to disable, `*` to match everything) or an object:

```jsonc
{
  "plugins": [
    { "package": "@acme/opencode-plugin", "options": { "agent": "reviewer" } }
  ]
}
```

- `package` accepts npm names/versions, Git specs, and local paths (`./`,
  `../`, `/absolute`, `file://`). Relative paths resolve from the config file
  containing the entry.
- `options` is arbitrary JSON. OpenCode does not validate it.
- `{env:VAR}` substitution happens before the value reaches the plugin, so a
  plugin always sees resolved strings.
- `plugins` arrays from every applicable config file are combined
  lowest-to-highest precedence; global is lowest.

### Reading it

Server entry (`index.ts`):

```ts
import type { PluginOptions } from "@opencode/plugin"

setup(ctx) {
  const raw: PluginOptions = ctx.options   // Readonly<Record<string, any>>
}
```

TUI entry (`tui.tsx`):

```ts
setup(ctx) {
  const raw: Readonly<Record<string, any>> = ctx.options
}
```

Both are the same options object from the same config entry. Neither is typed or
validated. `PluginOptions` is defined as `Readonly<Record<string, any>>`.

### Auto-discovered local plugins

Plugins in `.opencode/plugins/<id>/` (and global `~/.config/opencode/plugins/`)
are loaded automatically, without a `plugins` entry. Observed behavior in this
repo: discovered plugins receive `options = {}`; adding the object-form entry
pointing at the same local package supplies the real options and reloads the
plugin. To configure an auto-discovered plugin, add the object-form entry.

## Storage

Plugin-scoped durable JSON. This is where the plugin keeps state it owns.

### Server (`ctx.storage`)

```ts
interface StorageDomain {
  get(key: string): Promise<Json | undefined>
  set(key: string, value: Json): Promise<void>
  remove(key: string): Promise<void>
  scan(options: StorageScanOptions): Promise<StorageScanResult>
}

interface StorageScanOptions {
  prefix: string
  after?: string
  limit?: number
}

interface StorageScanResult {
  entries: readonly { key: string; value: Json }[]
  next?: string
}
```

Values must be JSON-serializable. `scan` pages by prefix with an opaque cursor in
`next`.

### TUI (`context.storage`)

```ts
context.storage.store<Value extends object>(key: string, options: {
  initial: Value
}): readonly [Store<Value>, (mutation: (draft: Value) => void) => Promise<void>]

context.storage.memory<Value extends object>(key: string, options: {
  initial: Value
}): readonly [Store<Value>, (mutation: (draft: Value) => void) => void]
```

- `store` persists and stays live-synced across running TUI instances; the
  updater returns a promise.
- `memory` survives plugin hot reloads but is discarded when the TUI exits, and
  the updater is synchronous.
- Both return a Solid `Store`, so reads are reactive.

## Choosing between them

| Question | Answer |
| --- | --- |
| Does the user write it by hand in `opencode.json(c)`? | option |
| Must it survive a plugin reload without code changes? | option (config) |
| Does the plugin write it while running? | storage |
| Is it per-user but not worth a config diff? | storage, durable `store` |
| Is it ephemeral UI state? | storage, `memory` |
| Is it a secret? | option with `{env:VAR}`, never storage |

## Known gotchas

- **No validation.** `parseSettings` is the only guard; OpenCode passes options
  through untouched.
- **Two instances.** Server and TUI entrypoints are separate plugin instances, so
  parse options once per instance from one shared module.
- **Reads during setup.** Options are read when the plugin loads. Editing
  `opencode.json(c)` reloads the plugin (watched config dirs); unrelated local
  dependency changes may need `opencode service restart`.
- **Duplicate-looking behavior.** If a local plugin is both discovered and
  listed, confirm in the plugin manager that it is not active twice before
  debugging the config further.
