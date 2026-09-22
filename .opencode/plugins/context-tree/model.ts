import type { Context } from "@opencode/plugin/tui/context"
import type {
  SessionInfo,
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  TokenUsageInfo,
} from "@opencode/client"

/**
 * Read model for the context family tree.
 *
 * A *lane* is a session: one contiguous line of thought. Lanes are joined by
 * fork links (`Session.Info.fork`), which carry the exact boundary message in
 * the parent where the branch diverged. A *subagent* is a child session with a
 * `parentID` but no `fork`; it belongs to the turn of its parent that spawned
 * it, rather than being a sibling lane.
 *
 * Everything here reads `ctx.data.session.*`, which is reactive, so a caller
 * must invoke it inside a Solid computation to get live updates.
 */

export type ViewMode = "turn" | "message" | "step"
export type RunState = "running" | "idle"
export type Tone =
  | "default"
  | "user"
  | "assistant"
  | "tool"
  | "running"
  | "success"
  | "error"
  | "warning"
  | "info"
  | "muted"

export interface ToolLine {
  id: string
  name: string
  status: "streaming" | "running" | "completed" | "error"
  summary: string
  input: string[]
  output: string[]
  error?: string
}

export interface SubagentRef {
  sessionID: string
  title: string
  run: RunState
  messages: number
  created: number
}

export interface Branch {
  childID: string
  title: string
  boundary?: string
  created: number
  userTurns: number
}

export interface Card {
  key: string
  kind: "card" | "branch"
  badge: string
  title: string
  tone: Tone
  status: "done" | "running" | "error"
  head: string[]
  detail: string[]
  toolLines: ToolLine[]
  files: string[]
  time: number
  durationMs?: number
  tokens?: TokenUsageInfo
  cost?: number
  subagents: SubagentRef[]
  branch?: Branch
  messageIDs: string[]
}

export interface Lane {
  sessionID: string
  title: string
  run: RunState
  outcome?: "succeeded" | "failed" | "interrupted"
  isRoot: boolean
  isCurrent: boolean
  parentID?: string
  forkFrom?: string
  messages: SessionMessageInfo[]
  subagents: SubagentRef[]
  branches: Branch[]
  tokens: TokenUsageInfo
  cost: number
}

export interface Family {
  rootID: string
  lanes: Lane[]
  byID: Record<string, Lane>
  current: string
}

const MAX_TOOL_LINES = 40
const MAX_DETAIL_LINES = 400

export function zeroTokens(): TokenUsageInfo {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addTokens(a: TokenUsageInfo, b: TokenUsageInfo | undefined): TokenUsageInfo {
  if (!b) return a
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write },
  }
}

function messageEnd(message: SessionMessageInfo): number {
  const completed = (message.time as { completed?: number }).completed
  return typeof completed === "number" ? completed : message.time.created
}

function sortMessages(messages: SessionMessageInfo[]): SessionMessageInfo[] {
  return [...messages].sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n")
}

function clip(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines
  return [...lines.slice(0, max), `… ${lines.length - max} more line${lines.length - max === 1 ? "" : "s"}`]
}

function stringify(value: unknown): string[] {
  if (value == null) return []
  if (typeof value === "string") return splitLines(value)
  try {
    return splitLines(JSON.stringify(value, null, 2) ?? "")
  } catch {
    return [String(value)]
  }
}

function toolInput(tool: SessionMessageAssistantTool): Record<string, unknown> {
  const state = tool.state
  if (state.status === "streaming") return {}
  return state.input as Record<string, unknown>
}

function toolLine(tool: SessionMessageAssistantTool): ToolLine {
  const state = tool.state
  if (state.status === "streaming") {
    return { id: tool.id, name: tool.name, status: "streaming", summary: "…", input: [state.input], output: [] }
  }

  const input = toolInput(tool)
  if (state.status === "running") {
    return {
      id: tool.id,
      name: tool.name,
      status: "running",
      summary: toolSummary(tool.name, input),
      input: clip(stringify(input), MAX_TOOL_LINES),
      output: [],
    }
  }

  const content = state.content ?? []
  const output = content.map((item) => (item.type === "text" ? item.text : item.uri)).join("\n")
  if (state.status === "completed") {
    return {
      id: tool.id,
      name: tool.name,
      status: "completed",
      summary: toolSummary(tool.name, input),
      input: clip(stringify(input), MAX_TOOL_LINES),
      output: clip(splitLines(output), MAX_TOOL_LINES),
    }
  }

  return {
    id: tool.id,
    name: tool.name,
    status: "error",
    summary: toolSummary(tool.name, input),
    input: clip(stringify(input), MAX_TOOL_LINES),
    output: clip(splitLines(output), MAX_TOOL_LINES),
    error: state.error.message,
  }
}

/** A short, human-facing description of a tool call, from its most telling argument. */
function toolSummary(name: string, input: Record<string, unknown>): string {
  for (const key of ["command", "filePath", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0]
  }
  const first = Object.values(input)[0]
  if (typeof first === "string") return first.trim().split("\n")[0]
  return ""
}

function fileFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "file_path", "path"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

interface AssistantParts {
  texts: string[]
  reasoning: string[]
  tools: ToolLine[]
  files: string[]
  tokens: TokenUsageInfo
  cost: number
  running: boolean
  failed: boolean
  agent: string
  model: string
  finish?: string
}

function assistantParts(message: SessionMessageAssistant): AssistantParts {
  const texts: string[] = []
  const reasoning: string[] = []
  const tools: ToolLine[] = []
  const files = new Set<string>(message.snapshot?.files ?? [])

  for (const item of message.content) {
    if (item.type === "text") texts.push(item.text)
    else if (item.type === "reasoning") reasoning.push(item.text)
    else {
      tools.push(toolLine(item))
      if (item.name === "task" || item.name === "edit" || item.name === "write" || item.name === "patch") {
        const file = fileFromInput(toolInput(item))
        if (file) files.add(file)
      }
    }
  }

  const running = tools.some((tool) => tool.status === "streaming" || tool.status === "running")
  const failed = message.error != null || tools.some((tool) => tool.status === "error")

  return {
    texts,
    reasoning,
    tools,
    files: [...files],
    tokens: message.tokens ?? zeroTokens(),
    cost: message.cost ?? 0,
    running,
    failed,
    agent: message.agent,
    model: message.model ? `${message.model.providerID}/${message.model.id}` : "",
    finish: message.finish,
  }
}

function toolDetail(tool: ToolLine): string[] {
  const lines: string[] = []
  lines.push(`▸ ${tool.name}${tool.summary ? `  ${tool.summary}` : ""}  [${tool.status}]`)
  if (tool.error) lines.push(`  error: ${tool.error}`)
  if (tool.input.length) {
    lines.push("  input:")
    lines.push(...tool.input.map((line) => `    ${line}`))
  }
  if (tool.output.length) {
    lines.push("  output:")
    lines.push(...tool.output.map((line) => `    ${line}`))
  }
  return lines
}

function toolsDetail(tools: ToolLine[]): string[] {
  return tools.flatMap(toolDetail)
}

function summaryLine(parts: {
  tools: number
  failed: number
  files: string[]
  durationMs?: number
  tokens?: TokenUsageInfo
  cost?: number
}): string {
  const bits: string[] = []
  if (parts.tools) bits.push(`${parts.tools} tool${parts.tools === 1 ? "" : "s"}${parts.failed ? ` (${parts.failed} failed)` : ""}`)
  if (parts.files.length) bits.push(`${parts.files.length} file${parts.files.length === 1 ? "" : "s"}`)
  if (parts.durationMs && parts.durationMs > 0) bits.push(formatDuration(parts.durationMs))
  if (parts.tokens && parts.tokens.output) bits.push(`${parts.tokens.output} out tok`)
  if (parts.cost) bits.push(`$${parts.cost.toFixed(4)}`)
  return bits.join(" · ")
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m${rest.toString().padStart(2, "0")}s`
}

/** Resolve the root of a session's parent chain, tolerating missing intermediates. */
function resolveRoot(all: Map<string, SessionInfo>, seed: string): string {
  let root = seed
  const seen = new Set<string>()
  while (!seen.has(root)) {
    seen.add(root)
    const info = all.get(root)
    const parent = info?.parentID ?? info?.fork?.sessionID
    if (!parent || !all.has(parent)) break
    root = parent
  }
  return root
}

function descendants(all: Map<string, SessionInfo>, rootID: string): SessionInfo[] {
  const out: SessionInfo[] = []
  const seen = new Set<string>()
  const stack = [rootID]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const info = all.get(id)
    if (!info) continue
    out.push(info)
    for (const candidate of all.values()) {
      const parent = candidate.parentID ?? candidate.fork?.sessionID
      if (parent === id) stack.push(candidate.id)
    }
  }
  return out
}

const USER_TYPES = new Set(["user"])

function countUserTurns(messages: SessionMessageInfo[]): number {
  return messages.reduce((count, message) => count + (USER_TYPES.has(message.type) ? 1 : 0), 0)
}

/**
 * Assemble the family for `seed` (or the most recently updated session). Returns
 * undefined when no sessions are loaded yet.
 */
export function loadFamily(ctx: Context, seed: string | undefined): Family | undefined {
  const sessions = ctx.data.session.list()
  if (!sessions.length) return undefined

  const all = new Map(sessions.map((session) => [session.id, session]))
  const chosen = seed && all.has(seed) ? seed : [...sessions].sort((a, b) => b.time.updated - a.time.updated)[0].id
  const rootID = resolveRoot(all, chosen)
  const members = descendants(all, rootID)

  const byID: Record<string, Lane> = {}
  const lanes: Lane[] = members.map((info) => {
    const messages = sortMessages(ctx.data.session.message.list(info.id) ?? [])
    const lane: Lane = {
      sessionID: info.id,
      title: info.title?.trim() || info.id,
      run: ctx.data.session.status(info.id),
      outcome: info.outcome,
      isRoot: info.id === rootID,
      isCurrent: info.id === chosen,
      parentID: info.parentID,
      forkFrom: info.fork ? (info.parentID ?? info.fork.sessionID) : undefined,
      messages,
      subagents: [],
      branches: [],
      tokens: info.tokens ?? zeroTokens(),
      cost: info.cost ?? 0,
    }
    byID[info.id] = lane
    return lane
  })

  for (const info of members) {
    const lane = byID[info.id]
    if (!lane) continue
    const parent = all.get(info.parentID ?? info.fork?.sessionID ?? "")
    const isFork = info.fork != null
    if (isFork) {
      const target = (info.parentID && byID[info.parentID]) || (info.fork && byID[info.fork.sessionID])
      if (target) {
        target.branches.push({
          childID: info.id,
          title: lane.title,
          boundary: info.fork?.boundary.messageID,
          created: info.time.created,
          userTurns: countUserTurns(lane.messages),
        })
      }
    } else if (parent && byID[parent.id] && byID[parent.id] !== lane) {
      byID[parent.id].subagents.push({
        sessionID: info.id,
        title: lane.title,
        run: lane.run,
        messages: lane.messages.length,
        created: info.time.created,
      })
    }
  }

  for (const lane of lanes) {
    lane.branches.sort((a, b) => a.created - b.created)
    lane.subagents.sort((a, b) => a.created - b.created)
  }

  return { rootID, lanes, byID, current: chosen }
}

/** Ancestry chain from the root down to `sessionID`, inclusive. */
export function ancestry(family: Family, sessionID: string): Lane[] {
  const chain: Lane[] = []
  let cursor: string | undefined = sessionID
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const lane: Lane | undefined = family.byID[cursor]
    if (!lane) break
    chain.unshift(lane)
    cursor = lane.parentID ?? lane.forkFrom
  }
  return chain
}

function attachSubagents(cards: Card[], subagents: SubagentRef[]): void {
  if (!subagents.length || !cards.length) return
  for (const ref of subagents) {
    let target = cards.findIndex((card) => card.time >= ref.created)
    if (target < 0) target = cards.length - 1
    if (target > 0 && cards[target].time > ref.created) target -= 1
    const card = cards[Math.max(0, target)]
    card.subagents.push(ref)
  }
}

function branchCard(branch: Branch): Card {
  return {
    key: `branch:${branch.childID}`,
    kind: "branch",
    badge: "BRANCH",
    title: branch.title,
    tone: "info",
    status: "done",
    head: [],
    detail: [],
    toolLines: [],
    files: [],
    time: branch.created,
    subagents: [],
    branch,
    messageIDs: [],
  }
}

function placeBranches(cards: Card[], branches: Branch[]): Card[] {
  if (!branches.length) return cards
  const placed = new Map<number, Branch[]>()
  for (const branch of branches) {
    let index = branch.boundary ? cards.findIndex((card) => card.messageIDs.includes(branch.boundary!)) : -1
    if (index < 0) {
      index = cards.findIndex((card) => card.time >= branch.created)
      if (index < 0) index = cards.length - 1
      else if (index > 0) index -= 1
    }
    const list = placed.get(index) ?? []
    list.push(branch)
    placed.set(index, list)
  }

  const out: Card[] = []
  cards.forEach((card, index) => {
    out.push(card)
    const list = placed.get(index)
    if (list) for (const branch of list) out.push(branchCard(branch))
  })
  return out
}

function cardKey(sessionID: string, id: string, suffix = ""): string {
  return `${sessionID}:${id}${suffix ? `:${suffix}` : ""}`
}

function messageCard(sessionID: string, message: SessionMessageInfo): Card | undefined {
  const base = {
    key: cardKey(sessionID, message.id),
    kind: "card" as const,
    toolLines: [] as ToolLine[],
    subagents: [] as SubagentRef[],
    messageIDs: [message.id],
    time: message.time.created,
  }

  switch (message.type) {
    case "user": {
      const lines = splitLines(message.text)
      const meta: string[] = []
      if (message.files?.length) meta.push(`${message.files.length} file${message.files.length === 1 ? "" : "s"} attached`)
      if (message.agents?.length) meta.push(`agents: ${message.agents.map((a) => a.name).join(", ")}`)
      if (message.skills?.length) meta.push(`skills: ${message.skills.map((s) => s.name).join(", ")}`)
      return {
        ...base,
        badge: "YOU",
        title: lines[0]?.trim() || "(empty prompt)",
        tone: "user",
        status: "done",
        head: [...clip(lines.slice(1), 8), ...meta],
        detail: clip(lines, MAX_DETAIL_LINES),
        files: [],
      }
    }
    case "assistant": {
      const parts = assistantParts(message)
      const head: string[] = []
      if (parts.model) head.push(`⚙ ${parts.agent} · ${parts.model}`)
      const finalText = parts.texts[parts.texts.length - 1]
      if (finalText) head.push(...clip(splitLines(finalText.trim()), 6))
      const summary = summaryLine({
        tools: parts.tools.length,
        failed: parts.tools.filter((tool) => tool.status === "error").length,
        files: parts.files,
        durationMs: messageEnd(message) - message.time.created,
        tokens: parts.tokens,
        cost: parts.cost,
      })
      if (summary) head.push(summary)
      if (parts.finish && parts.finish !== "stop" && parts.finish !== "tool-calls") head.push(`finish: ${parts.finish}`)

      const detail: string[] = []
      if (parts.texts.length) {
        detail.push("── reply ──")
        for (const text of parts.texts) detail.push(...splitLines(text.trim()))
      }
      if (parts.reasoning.length) {
        detail.push("── reasoning ──")
        for (const text of parts.reasoning) detail.push(...splitLines(text.trim()))
      }
      if (parts.tools.length) {
        detail.push("── tools ──")
        detail.push(...toolsDetail(parts.tools))
      }

      return {
        ...base,
        badge: "ASSISTANT",
        title: message.error ? `error: ${message.error.message}` : parts.tools.length ? `${parts.tools.length} tool calls` : "reply",
        tone: parts.failed ? "error" : parts.running ? "running" : "assistant",
        status: parts.failed ? "error" : parts.running ? "running" : "done",
        head,
        detail: clip(detail, MAX_DETAIL_LINES),
        toolLines: parts.tools,
        files: parts.files,
        durationMs: messageEnd(message) - message.time.created,
        tokens: parts.tokens,
        cost: parts.cost,
      }
    }
    case "shell": {
      const output = message.output?.output ? splitLines(message.output.output.trim()) : []
      const status: Card["status"] = message.status === "running" ? "running" : message.exit && message.exit !== 0 ? "error" : "done"
      return {
        ...base,
        badge: "SHELL",
        title: message.command,
        tone: status === "running" ? "running" : status === "error" ? "error" : "tool",
        status,
        head: [`$ ${message.command}`, ...clip(output.slice(-6), 6)],
        detail: clip([`$ ${message.command}`, ...(output.length ? ["", ...output] : [])], MAX_DETAIL_LINES),
        files: [],
        durationMs: message.time.completed ? message.time.completed - message.time.created : undefined,
      }
    }
    case "compaction": {
      const summary = "summary" in message ? message.summary : ""
      const status: Card["status"] = message.status === "failed" ? "error" : message.status === "running" ? "running" : "done"
      return {
        ...base,
        badge: "COMPACT",
        title: `${message.reason} · ${message.status}`,
        tone: status === "error" ? "error" : "warning",
        status,
        head: summary ? clip(splitLines(summary.trim()), 4) : [],
        detail: clip(splitLines(summary.trim()), MAX_DETAIL_LINES),
        files: [],
      }
    }
    case "idle":
      return {
        ...base,
        badge: "IDLE",
        title: message.outcome,
        tone: message.outcome === "succeeded" ? "success" : message.outcome === "failed" ? "error" : "warning",
        status: message.outcome === "failed" ? "error" : "done",
        head: [],
        detail: [],
        files: [],
      }
    case "system":
    case "synthetic": {
      const text = message.text
      return {
        ...base,
        badge: message.type === "system" ? "SYSTEM" : "SYNTHETIC",
        title: message.description || lines1(text),
        tone: "muted",
        status: "done",
        head: clip(splitLines(text.trim()), 4),
        detail: clip(splitLines(text.trim()), MAX_DETAIL_LINES),
        files: [],
      }
    }
    case "skill":
      return {
        ...base,
        badge: "SKILL",
        title: message.name,
        tone: "info",
        status: "done",
        head: clip(splitLines(message.text.trim()), 4),
        detail: clip(splitLines(message.text.trim()), MAX_DETAIL_LINES),
        files: [],
      }
    case "agent-switched":
      return {
        ...base,
        badge: "AGENT",
        title: `${message.previous ? `${message.previous} → ` : ""}${message.agent}`,
        tone: "muted",
        status: "done",
        head: [],
        detail: [],
        files: [],
      }
    case "model-switched":
      return {
        ...base,
        badge: "MODEL",
        title: `${message.model.providerID}/${message.model.id}`,
        tone: "muted",
        status: "done",
        head: [],
        detail: [],
        files: [],
      }
    case "location-switched":
      return {
        ...base,
        badge: "CWD",
        title: message.location.directory,
        tone: "muted",
        status: "done",
        head: [],
        detail: [],
        files: [],
      }
    default:
      return undefined
  }
}

function lines1(text: string): string {
  return splitLines(text.trim())[0] ?? ""
}

interface Turn {
  messages: SessionMessageInfo[]
}

function groupTurns(messages: SessionMessageInfo[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | undefined
  for (const message of messages) {
    if (message.type === "user" || !current) {
      current = { messages: [message] }
      turns.push(current)
    } else {
      current.messages.push(message)
    }
  }
  return turns
}

function turnCard(sessionID: string, turn: Turn, index: number): Card {
  const first = turn.messages[0]
  const last = turn.messages[turn.messages.length - 1]
  const user = turn.messages.find((message) => message.type === "user")
  const assistants = turn.messages.filter((message): message is SessionMessageAssistant => message.type === "assistant")

  const tools: ToolLine[] = []
  const files = new Set<string>()
  let tokens = zeroTokens()
  let cost = 0
  let failed = false
  let running = false
  const text: string[] = []

  for (const assistant of assistants) {
    const parts = assistantParts(assistant)
    tools.push(...parts.tools)
    parts.files.forEach((file) => files.add(file))
    tokens = addTokens(tokens, parts.tokens)
    cost += parts.cost
    failed = failed || parts.failed
    running = running || parts.running
    if (parts.texts.length) text.push(...splitLines(parts.texts[parts.texts.length - 1].trim()))
  }

  const userText = user && user.type === "user" ? splitLines(user.text) : []
  const summary = summaryLine({
    tools: tools.length,
    failed: tools.filter((tool) => tool.status === "error").length,
    files: [...files],
    durationMs: messageEnd(last) - first.time.created,
    tokens,
    cost,
  })

  const head: string[] = []
  if (text.length) head.push(...clip(text, 6))
  if (summary) head.push(summary)

  const detail: string[] = []
  if (userText.length) {
    detail.push("── prompt ──", ...userText)
  }
  if (text.length) {
    detail.push("── reply ──", ...text)
  }
  if (tools.length) {
    detail.push("── tools ──", ...toolsDetail(tools))
  }

  return {
    key: cardKey(sessionID, first.id, `t${index}`),
    kind: "card",
    badge: `TURN ${index + 1}`,
    title: userText[0]?.trim() || first.type.toUpperCase(),
    tone: failed ? "error" : running ? "running" : "user",
    status: failed ? "error" : running ? "running" : "done",
    head,
    detail: clip(detail, MAX_DETAIL_LINES),
    toolLines: tools,
    files: [...files],
    time: first.time.created,
    durationMs: messageEnd(last) - first.time.created,
    tokens,
    cost,
    subagents: [],
    messageIDs: turn.messages.map((message) => message.id),
  }
}

function stepCards(sessionID: string, message: SessionMessageAssistant): Card[] {
  const parts = assistantParts(message)
  const cards: Card[] = []
  let partIndex = 0
  let pending: ToolLine[] = []

  const flushTools = () => {
    if (!pending.length) return
    const tools = pending
    pending = []
    cards.push({
      key: cardKey(sessionID, message.id, `s${partIndex++}`),
      kind: "card",
      badge: "TOOLS",
      title: `${tools.length} call${tools.length === 1 ? "" : "s"}`,
      tone: tools.some((tool) => tool.status === "error") ? "error" : tools.some((tool) => tool.status !== "completed") ? "running" : "tool",
      status: tools.some((tool) => tool.status === "error") ? "error" : tools.some((tool) => tool.status !== "completed") ? "running" : "done",
      head: tools.map((tool) => `${tool.name}${tool.summary ? `  ${tool.summary}` : ""}`),
      detail: toolsDetail(tools),
      toolLines: tools,
      files: [],
      time: message.time.created,
      subagents: [],
      messageIDs: [message.id],
    })
  }

  for (const item of message.content) {
    if (item.type === "tool") {
      pending.push(toolLine(item))
      continue
    }
    flushTools()
    const text = item.text.trim()
    if (!text) continue
    const isReasoning = item.type === "reasoning"
    cards.push({
      key: cardKey(sessionID, message.id, `s${partIndex++}`),
      kind: "card",
      badge: isReasoning ? "THINK" : "SAY",
      title: lines1(text),
      tone: isReasoning ? "muted" : "assistant",
      status: "done",
      head: clip(splitLines(text).slice(1), 6),
      detail: clip(splitLines(text), MAX_DETAIL_LINES),
      toolLines: [],
      files: [],
      time: message.time.created,
      subagents: [],
      messageIDs: [message.id],
    })
  }
  flushTools()

  if (message.error) {
    cards.push({
      key: cardKey(sessionID, message.id, "err"),
      kind: "card",
      badge: "ERROR",
      title: message.error.message,
      tone: "error",
      status: "error",
      head: [],
      detail: [],
      toolLines: [],
      files: [],
      time: message.time.created,
      subagents: [],
      messageIDs: [message.id],
    })
  }

  return cards
}

/** Group a lane's messages into renderable cards for the given view mode. */
export function buildCards(lane: Lane, mode: ViewMode): Card[] {
  let cards: Card[]
  if (mode === "turn") {
    cards = groupTurns(lane.messages).map((turn, index) => turnCard(lane.sessionID, turn, index))
  } else if (mode === "step") {
    cards = []
    for (const message of lane.messages) {
      if (message.type === "assistant") cards.push(...stepCards(lane.sessionID, message))
      else {
        const card = messageCard(lane.sessionID, message)
        if (card) cards.push(card)
      }
    }
  } else {
    cards = []
    for (const message of lane.messages) {
      const card = messageCard(lane.sessionID, message)
      if (card) cards.push(card)
    }
  }

  // Subagents attach to the card active when they were spawned; branches attach
  // at their fork boundary message (or, failing that, by creation time).
  for (const card of cards) card.subagents = []
  attachSubagents(cards, lane.subagents)
  return placeBranches(cards, lane.branches)
}
