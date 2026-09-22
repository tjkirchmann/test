import { For, Show, createMemo, createSignal } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import type { Destination } from "@opencode/plugin/tui/context"
import { loadTree, type RunState, type SessionNode, type TreeModel } from "./model"

interface Row {
  key: string
  depth: number
  kind: "node" | "session"
  run: RunState
  title: string
  meta: string
  expandable: boolean
  expanded: boolean
}

const GLYPH: Record<RunState, string> = { running: "●", idle: "○" }

function flatten(model: TreeModel | undefined, collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = []
  if (!model) return rows

  const pushSessions = (sessions: SessionNode[], depth: number) => {
    for (const session of sessions) {
      const expanded = !collapsed.has(session.id)
      rows.push({
        key: session.id,
        depth,
        kind: "session",
        run: session.run,
        title: session.title,
        meta: session.subagent ? "subagent" : "",
        expandable: session.children.length > 0,
        expanded,
      })
      if (expanded) pushSessions(session.children, depth + 1)
    }
  }

  for (const node of model.nodes) {
    const expanded = !collapsed.has(node.id)
    const meta = [
      node.branch ? `⎇ ${node.branch}` : "no branch",
      `${node.sessions.length} session${node.sessions.length === 1 ? "" : "s"}`,
      node.runningShells > 0 ? `${node.runningShells} shell${node.runningShells === 1 ? "" : "s"}` : "",
      node.kind === "root" ? "root" : "",
      node.current ? "current" : "",
    ].filter(Boolean)
    rows.push({
      key: node.id,
      depth: 0,
      kind: "node",
      run: node.run,
      title: node.name,
      meta: meta.join(" · "),
      expandable: node.sessions.length > 0,
      expanded,
    })
    if (expanded) pushSessions(node.sessions, 1)
  }
  return rows
}

/**
 * A plain destination snapshot of the route the tree was opened from. It is
 * captured field-by-field at open time because `router.current()` is live.
 */
export function TreeView(props: { back?: Destination }) {
  const ctx = usePlugin()
  const [model, setModel] = createSignal<TreeModel>()
  const [error, setError] = createSignal<string>()
  const [cursor, setCursor] = createSignal(0)
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())

  const refresh = async () => {
    try {
      setModel(await loadTree(ctx))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  void refresh()

  const rows = createMemo(() => flatten(model(), collapsed()))
  const index = createMemo(() => Math.min(cursor(), Math.max(0, rows().length - 1)))
  const viewport = createMemo(() => Math.max(6, (ctx.renderer.terminalHeight || 24) - 8))
  const window = createMemo(() => {
    const list = rows()
    const size = viewport()
    const start = list.length <= size ? 0 : Math.max(0, Math.min(list.length - size, index() - Math.floor(size / 2)))
    return { start, list: list.slice(start, start + size) }
  })

  const move = (delta: number) => setCursor(Math.max(0, Math.min(rows().length - 1, index() + delta)))
  const toggle = (row: Row | undefined, expand: boolean) => {
    if (!row) return
    const next = new Set(collapsed())
    if (row.expandable && expand) next.delete(row.key)
    else if (row.expandable) next.add(row.key)
    else if (!expand) return
    setCollapsed(next)
  }

  ctx.keymap.layer(() => ({
    mode: "global",
    priority: 30,
    commands: [
      { id: "context-tree.down", bind: "j", run: () => move(1) },
      { id: "context-tree.up", bind: "k", run: () => move(-1) },
      { id: "context-tree.first", bind: "gg", run: () => setCursor(0) },
      { id: "context-tree.last", bind: "shift+g", run: () => setCursor(rows().length - 1) },
      { id: "context-tree.expand", bind: "l", run: () => toggle(rows()[index()], true) },
      { id: "context-tree.collapse", bind: "h", run: () => toggle(rows()[index()], false) },
      { id: "context-tree.refresh", bind: "r", run: () => void refresh() },
      {
        id: "context-tree.close",
        bind: "escape",
        run: () => ctx.ui.router.navigate(props.back ?? { type: "home" }),
      },
    ],
    bindings: [
      "context-tree.down",
      "context-tree.up",
      "context-tree.first",
      "context-tree.last",
      "context-tree.expand",
      "context-tree.collapse",
      "context-tree.refresh",
      "context-tree.close",
    ],
  }))

  const color = (row: Row) =>
    row.run === "running" ? ctx.theme.text.feedback.success.base : row.kind === "node" ? ctx.theme.text.base : ctx.theme.text.muted

  return (
    <box flexDirection="column" padding={1}>
      <box flexDirection="row">
        <text fg={ctx.theme.text.base}>Context Tree</text>
        <text fg={ctx.theme.text.muted}>{model() ? `  ${ctx.ui.format.path(model()!.canonical)}` : ""}</text>
      </box>

      <Show when={error()}>
        <text fg={ctx.theme.text.feedback.error.base}>{error()}</text>
      </Show>

      <Show when={!model() && !error()}>
        <text fg={ctx.theme.text.muted}>loading…</text>
      </Show>

      <Show when={model() && rows().length === 0}>
        <text fg={ctx.theme.text.muted}>no sessions or worktrees in this project</text>
      </Show>

      <box flexDirection="column" marginTop={1}>
        <For each={window().list}>
          {(row, i) => {
            const selected = () => window().start + i() === index()
            const marker = () => (selected() ? "▸ " : "  ")
            const fold = () => (row.expandable ? (row.expanded ? "▾ " : "▸ ") : "  ")
            const indent = () => "  ".repeat(row.depth)
            return (
              <text fg={color(row)}>
                {`${marker()}${indent()}${fold()}${GLYPH[row.run]} ${row.title}${row.meta ? `  ${row.meta}` : ""}`}
              </text>
            )
          }}
        </For>
      </box>

      <box flexDirection="row" marginTop={1}>
        <text fg={ctx.theme.text.muted}>{`${rows().length} rows · `}</text>
        <text fg={ctx.theme.text.feedback.success.base}>
          <b>{"j/k move · h/l fold · gg/G ends · r refresh · esc back"}</b>
        </text>
      </box>
    </box>
  )
}
