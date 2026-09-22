import { Plugin } from "@opencode/plugin"

/**
 * Server-side entrypoint for the context-tree plugin.
 *
 * Required for the plugin directory to be discovered and activated. Milestone 1
 * is read-only and lives entirely in the TUI, so this is intentionally a no-op
 * for now. Run-state event capture (shell/pty lifecycle -> storage) lands here
 * in a later milestone.
 */
export default Plugin.define({
  id: "context-tree",
  setup() {},
})
