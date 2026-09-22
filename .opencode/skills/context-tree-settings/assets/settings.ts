import type { PluginOptions } from "@opencode/plugin"

/**
 * Settings for the context-tree plugin.
 *
 * Values come from the plugin entry's `options` in `opencode.json(c)` and are
 * normalized by `parseSettings`. Everything downstream reads this resolved
 * shape, never the raw options.
 */
export interface Settings {
  commands: {
    /** Run once when a node's worktree is created. */
    setup?: string
    build?: string
    test?: string
    run?: string
  }
  ports: {
    /** First port handed to a node. */
    base: number
    /** Ports reserved per node; node n starts at base + n * stride. */
    stride: number
  }
}

export interface SettingsIssue {
  key: string
  message: string
}

export const DEFAULTS: Settings = {
  commands: {},
  ports: { base: 3000, stride: 10 },
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function port(value: unknown, fallback: number, key: string, issues: SettingsIssue[]): number {
  if (value === undefined) return fallback
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) return value
  issues.push({ key, message: `expected an integer between 1 and 65535; using ${fallback}` })
  return fallback
}

/**
 * Normalize opaque plugin options into typed settings.
 *
 * Lenient by design: a typo in `opencode.json(c)` falls back to a default and
 * records an issue instead of throwing, because a load failure would take the
 * whole plugin offline. Callers surface `issues` (TUI toast, server log).
 */
export function parseSettings(options: PluginOptions): { settings: Settings; issues: SettingsIssue[] } {
  const issues: SettingsIssue[] = []
  const commands = (options.commands ?? {}) as Record<string, unknown>
  const ports = (options.ports ?? {}) as Record<string, unknown>

  return {
    settings: {
      commands: {
        setup: text(commands.setup),
        build: text(commands.build),
        test: text(commands.test),
        run: text(commands.run),
      },
      ports: {
        base: port(ports.base, DEFAULTS.ports.base, "ports.base", issues),
        stride: port(ports.stride, DEFAULTS.ports.stride, "ports.stride", issues),
      },
    },
    issues,
  }
}
