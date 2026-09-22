import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import type { BoxRenderable } from "@opentui/core"
import { usePlugin } from "@opencode/plugin/tui"
import type { Destination } from "@opencode/plugin/tui/context"
import type { ResolvedTheme } from "@opencode/theme/tui"
import type { Branch, Card, Family, Lane, SubagentRef, Tone, ViewMode } from "./model"
import { ancestry, buildCards, loadFamily } from "./model"

const MODES: ViewMode[] = ["turn", "message", "step"]
const MODE_LABEL: Record<ViewMode, string> = { turn: "turns", message: "messages", step: "steps" }

type Row =
  | { kind: "card"; key: string; height: number; card: Card; lane: Lane; expanded: boolean; lines: string[]; depth: number }
  | { kind: "branch"; key: string; height: number; branch: Branch; depth: number }
  | { kind: "chip"; key: string; height: number; ref: SubagentRef; cardKey: string; expanded: boolean; depth: number }

function toneColor(theme: ResolvedTheme, tone: Tone) {
  switch (tone) {
    case "running":
      return theme.text.feedback.info.base
    case "success":
      return theme.text.feedback.success.base
    case "error":
      return theme.text.feedback.error.base
    case "warning":
      return theme.text.feedback.warning.base
    case "info":
      return theme.text.feedback.info.base
    case "muted":
    case "tool":
      return theme.text.muted
    default:
      return theme.text.base
  }
}

function marker(tone: Tone, running: boolean): string {
  if (running || tone === "running") return "◐"
  if (tone === "error") return "✖"
  if (tone === "success") return "●"
  return "○"
}

function bodyLines(card: Card, expanded: boolean): string[] {
  if (!expanded) return card.head
  if (!card.detail.length) return card.head
  return card.head.length ? [...card.head, "", ...card.detail] : card.detail
}

function laneRows(family: Family, lane: Lane, mode: ViewMode, expanded: ReadonlySet<string>, depth = 0, keyPrefix = ""): Row[] {
  const rows: Row[] = []
  const cards = buildCards(lane, mode)
  for (const card of cards) {
    if (card.kind === "branch" && card.branch) {
      rows.push({ kind: "branch", key: `${keyPrefix}${card.key}`, height: 1, branch: card.branch, depth })
      continue
    }
    const cardKey = `${keyPrefix}${card.key}`
    const isExpanded = expanded.has(cardKey)
    const lines = bodyLines(card, isExpanded)
    rows.push({ kind: "card", key: cardKey, height: 2 + lines.length, card, lane, expanded: isExpanded, lines, depth })
    for (const ref of card.subagents) {
      const chipKey = `${cardKey}::sub::${ref.sessionID}`
      const chipExpanded = expanded.has(chipKey)
      rows.push({ kind: "chip", key: chipKey, height: 1, ref, cardKey, expanded: chipExpanded, depth })
      const subLane = family.byID[ref.sessionID]
      if (chipExpanded && subLane) {
        rows.push(...laneRows(family, subLane, mode, expanded, depth + 1, `${ref.sessionID}::`))
      }
    }
  }
  return rows
}

function computeWindow(rows: Row[], cursor: number, viewport: number): { start: number; end: number } {
  if (!rows.length || viewport <= 0) return { start: 0, end: 0 }
  const index = Math.max(0, Math.min(rows.length - 1, cursor))
  let start = index
  let used = Math.min(rows[index].height, viewport)
  while (start > 0 && used + rows[start - 1].height <= viewport) {
    start -= 1
    used += rows[start].height
  }
  let end = index + 1
  while (end < rows.length && used + rows[end].height <= viewport) {
    used += rows[end].height
    end += 1
  }
  return { start, end }
}

export function TreeView(props: { back?: Destination; sessionID?: string }) {
  const ctx = usePlugin()
  const [mode, setMode] = createSignal<ViewMode>("turn")
  const [laneOverride, setLaneOverride] = createSignal<string>()
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [cursor, setCursor] = createSignal(0)

  const family = createMemo(() => loadFamily(ctx, props.sessionID))
  const activeLaneID = createMemo(() => {
    const fam = family()
    if (!fam) return undefined
    const override = laneOverride()
    if (override && fam.byID[override]) return override
    if (fam.byID[fam.current]) return fam.current
    return fam.rootID
  })
  const activeLane = createMemo(() => {
    const fam = family()
    const id = activeLaneID()
    return fam && id ? fam.byID[id] : undefined
  })
  const rows = createMemo(() => {
    const fam = family()
    const lane = activeLane()
    if (!fam || !lane) return []
    return laneRows(fam, lane, mode(), expanded())
  })

  const index = createMemo(() => Math.min(cursor(), Math.max(0, rows().length - 1)))
  // The card list is the flexible row between the header and the pinned footer,
  // so its measured height is exactly how many lines the window may use. Fall
  // back to a terminal-based estimate until the first layout pass reports it.
  const [listHeight, setListHeight] = createSignal(0)
  const viewport = createMemo(() => {
    const measured = listHeight()
    return measured > 0 ? measured : Math.max(3, (ctx.renderer.terminalHeight || 24) - 9)
  })
  const window = createMemo(() => {
    const list = rows()
    const { start, end } = computeWindow(list, index(), viewport())
    return { start, list: list.slice(start, end) }
  })

  // Keep every family member's transcript loaded so lanes and subagent chips
  // render without a manual refresh.
  const synced = new Set<string>()
  createEffect(() => {
    const fam = family()
    if (!fam) return
    for (const lane of fam.lanes) {
      if (synced.has(lane.sessionID)) continue
      synced.add(lane.sessionID)
      void ctx.data.session.message.sync(lane.sessionID).catch(() => {})
    }
  })

  const move = (delta: number) => setCursor(Math.max(0, Math.min(rows().length - 1, index() + delta)))

  const toggle = (row: Row | undefined) => {
    if (!row) return
    if (row.kind === "card") {
      const next = new Set(expanded())
      next.has(row.key) ? next.delete(row.key) : next.add(row.key)
      setExpanded(next)
      return
    }
    if (row.kind === "chip") {
      const next = new Set(expanded())
      next.has(row.key) ? next.delete(row.key) : next.add(row.key)
      setExpanded(next)
      return
    }
    switchLane(row.branch.childID)
  }

  const switchLane = (sessionID: string) => {
    setLaneOverride(sessionID)
    setCursor(0)
  }

  const goParent = () => {
    const lane = activeLane()
    const fam = family()
    if (!lane || !fam) return
    const parent = lane.parentID ?? lane.forkFrom
    if (parent && fam.byID[parent]) switchLane(parent)
  }

  const goChild = () => {
    const lane = activeLane()
    if (!lane || !lane.branches.length) return
    const row = rows()[index()]
    if (row && row.kind === "branch") return switchLane(row.branch.childID)
    return switchLane(lane.branches[0].childID)
  }

  const cycleMode = () => {
    const next = MODES[(MODES.indexOf(mode()) + 1) % MODES.length]
    setMode(next)
    setCursor(0)
  }

  ctx.keymap.layer(() => ({
    mode: "global",
    priority: 30,
    commands: [
      { id: "context-tree.down", bind: "j", run: () => move(1) },
      { id: "context-tree.up", bind: "k", run: () => move(-1) },
      { id: "context-tree.first", bind: "gg", run: () => setCursor(0) },
      { id: "context-tree.last", bind: "shift+g", run: () => setCursor(rows().length - 1) },
      { id: "context-tree.open", bind: "enter", run: () => toggle(rows()[index()]) },
      { id: "context-tree.parent", bind: "h", run: () => goParent() },
      { id: "context-tree.child", bind: "l", run: () => goChild() },
      { id: "context-tree.mode", bind: "m", run: () => cycleMode() },
      { id: "context-tree.refresh", bind: "r", run: () => {
        const id = activeLaneID()
        if (id) void ctx.data.session.sync(id)
      } },
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
      "context-tree.open",
      "context-tree.parent",
      "context-tree.child",
      "context-tree.mode",
      "context-tree.refresh",
      "context-tree.close",
    ],
  }))

  let listBox: BoxRenderable | undefined

  return (
    <box flexDirection="column" padding={1} height="100%" flexGrow={1} overflow="hidden">
      <Header family={family()} lane={activeLane()} mode={mode()} theme={ctx.theme} />

      <Show when={!family()}>
        <text fg={ctx.theme.text.muted}>loading family…</text>
      </Show>

      <Show when={family() && rows().length === 0}>
        <text fg={ctx.theme.text.muted}>no messages yet in this lane</text>
      </Show>

      <box
        ref={(el: BoxRenderable) => {
          listBox = el
          setListHeight(el.height)
        }}
        on:resize={() => listBox && setListHeight(listBox.height)}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        marginTop={1}
        overflow="hidden"
      >
        <For each={window().list}>
          {(row) => {
            const selected = () => window().start + window().list.indexOf(row) === index()
            return (
              <Show
                when={row.kind === "card" ? (row as Extract<Row, { kind: "card" }>) : undefined}
                fallback={
                  <Show
                    when={row.kind === "branch" ? (row as Extract<Row, { kind: "branch" }>) : undefined}
                    fallback={<Chip row={row as Extract<Row, { kind: "chip" }>} selected={selected()} theme={ctx.theme} />}
                  >
                    {(branch) => <BranchRow row={branch()} selected={selected()} theme={ctx.theme} />}
                  </Show>
                }
              >
                {(card) => <CardRow row={card()} selected={selected()} theme={ctx.theme} />}
              </Show>
            )
          }}
        </For>
      </box>

      <box flexDirection="row" flexShrink={0} marginTop={1}>
        <text fg={ctx.theme.text.muted}>{`${rows().length} rows · ${MODE_LABEL[mode()]} · `}</text>
        <text fg={ctx.theme.text.feedback.success.base}>
          <b>{"j/k move · enter expand · h/l lane · m mode · g/G ends · r refresh · esc back"}</b>
        </text>
      </box>
    </box>
  )
}

function Header(props: { family: Family | undefined; lane: Lane | undefined; mode: ViewMode; theme: ResolvedTheme }) {
  const trail = createMemo(() => {
    const fam = props.family
    const lane = props.lane
    if (!fam || !lane) return []
    return ancestry(fam, lane.sessionID)
  })

  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row">
        <text fg={props.theme.text.base}>Context Tree</text>
        <text fg={props.theme.text.muted}>{props.lane ? `  ${props.lane.title}` : ""}</text>
        <text fg={props.theme.text.muted}>{`  [${MODE_LABEL[props.mode]}]`}</text>
        <Show when={props.lane?.run === "running"}>
          <text fg={props.theme.text.feedback.info.base}>{"  running"}</text>
        </Show>
      </box>

      <Show when={trail().length > 1}>
        <box flexDirection="row">
          <text fg={props.theme.text.muted}>{"family: "}</text>
          <For each={trail()}>
            {(lane, i) => (
              <text fg={lane.sessionID === props.lane?.sessionID ? props.theme.text.feedback.info.base : props.theme.text.muted}>
                {(i() > 0 ? " → " : "") + (lane.isRoot ? "◆ " : "⑂ ") + lane.title}
              </text>
            )}
          </For>
        </box>
      </Show>

      <Show when={props.lane?.forkFrom && props.family}>
        <text fg={props.theme.text.muted}>
          {`forked from ${props.family!.byID[props.lane!.forkFrom!]?.title ?? props.lane!.forkFrom} at boundary`}
        </text>
      </Show>

      <Show when={props.lane && props.lane.branches.length > 0}>
        <box flexDirection="row">
          <text fg={props.theme.text.muted}>{"branches: "}</text>
          <For each={props.lane?.branches ?? []}>
            {(branch, i) => (
              <text fg={props.theme.text.feedback.info.base}>
                {(i() > 0 ? "  " : "") + `⑂ ${branch.title} (${branch.userTurns})`}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function CardRow(props: { row: Extract<Row, { kind: "card" }>; selected: boolean; theme: ResolvedTheme }) {
  const glyph = () => marker(props.row.card.tone, props.row.card.status === "running")
  const accent = () => (props.selected ? props.theme.text.action.primary.base : props.theme.border.base)
  const fg = () => (props.selected ? props.theme.text.base : toneColor(props.theme, props.row.card.tone))
  const title = () => `${props.row.card.badge}  ${props.row.card.title}`
  const indent = () => "  ".repeat(props.row.depth)

  return (
    <box flexDirection="row">
      <box flexDirection="column" width={2} flexShrink={0}>
        <text fg={fg()}>{glyph()}</text>
        <For each={Array.from({ length: Math.max(0, props.row.height - 1) })}>{() => <text fg={accent()}>{"│"}</text>}</For>
      </box>
      <box
        flexGrow={1}
        border
        borderStyle="rounded"
        borderColor={accent()}
        title={indent() + title()}
        titleColor={props.selected ? props.theme.text.action.primary.base : fg()}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <For each={props.row.lines}>
          {(line) => (
            <text fg={props.row.expanded ? fg() : props.theme.text.muted} wrapMode="none" truncate>
              {line || " "}
            </text>
          )}
        </For>
      </box>
    </box>
  )
}

function BranchRow(props: { row: Extract<Row, { kind: "branch" }>; selected: boolean; theme: ResolvedTheme }) {
  const color = () => (props.selected ? props.theme.text.base : props.theme.text.feedback.info.base)
  const bg = () => (props.selected ? props.theme.background.raised.high : undefined)
  return (
    <box flexDirection="row" height={1}>
      <text fg={color()} bg={bg()} wrapMode="none" truncate>
        {`├─ ⑂ ${props.row.branch.title}  (${props.row.branch.userTurns} turns)  → enter`}
      </text>
    </box>
  )
}

function Chip(props: { row: Extract<Row, { kind: "chip" }>; selected: boolean; theme: ResolvedTheme }) {
  const caret = () => (props.row.expanded ? "▾" : "▸")
  const color = () => (props.selected ? props.theme.text.base : props.row.ref.run === "running" ? props.theme.text.feedback.info.base : props.theme.text.muted)
  const bg = () => (props.selected ? props.theme.background.raised.high : undefined)
  const indent = () => "  ".repeat(props.row.depth)
  return (
    <box flexDirection="row" height={1}>
      <text fg={color()} bg={bg()} wrapMode="none" truncate>
        {`${indent()}│ ⌥ ${caret()} ${props.row.ref.title}  (${props.row.ref.messages} msgs)${props.row.ref.run === "running" ? "  running" : ""}`}
      </text>
    </box>
  )
}
