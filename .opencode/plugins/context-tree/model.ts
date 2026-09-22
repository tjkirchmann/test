import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"

export type RunState = "running" | "idle"

export interface SessionNode {
  id: string
  title: string
  run: RunState
  subagent: boolean
  updated: number
  children: SessionNode[]
}

export interface TreeNode {
  id: string
  directory: string
  name: string
  kind: "root" | "worktree"
  current: boolean
  branch?: string
  run: RunState
  runningShells: number
  sessions: SessionNode[]
}

export interface TreeModel {
  projectID: string
  canonical: string
  current: string
  nodes: TreeNode[]
}

function baseName(directory: string): string {
  const parts = directory.replace(/\/+$/, "").split("/")
  return parts[parts.length - 1] || directory
}

function forest(sessions: SessionInfo[], running: ReadonlySet<string>): SessionNode[] {
  const byID = new Map<string, SessionNode>()
  for (const session of sessions) {
    byID.set(session.id, {
      id: session.id,
      title: session.title?.trim() || session.id,
      run: running.has(session.id) ? "running" : "idle",
      subagent: session.parentID != null,
      updated: session.time.updated,
      children: [],
    })
  }

  const roots: SessionNode[] = []
  for (const session of sessions) {
    const node = byID.get(session.id)!
    const parent = session.parentID ? byID.get(session.parentID) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sort = (list: SessionNode[]) => {
    list.sort((a, b) => b.updated - a.updated)
    for (const node of list) sort(node.children)
  }
  sort(roots)
  return roots
}

function mostRecent(node: TreeNode): number {
  let newest = 0
  const walk = (list: SessionNode[]) => {
    for (const session of list) {
      if (session.updated > newest) newest = session.updated
      walk(session.children)
    }
  }
  walk(node.sessions)
  return newest
}

/**
 * Read-only assembly of the context tree for the current location's project.
 *
 * A node is a worktree (or the canonical checkout). Sessions are grouped by the
 * directory they run in, so they hang off the node that owns that directory.
 * `parentID` nesting is subagent context, rendered beneath its owning session.
 */
export async function loadTree(ctx: Context): Promise<TreeModel> {
  const location = ctx.location ?? ctx.data.location.default()
  const info = await ctx.client.location.get({ location: { directory: location.directory } })
  const projectID = info.project.id
  const canonical = info.project.canonical

  const [sessionPage, worktrees, active] = await Promise.all([
    ctx.client.session.list({ project: projectID, limit: 500, order: "desc" }),
    ctx.client.worktree.list({ projectID }),
    ctx.client.session.active(),
  ])

  const sessions = sessionPage.data
  const running = new Set(Object.keys(active ?? {}))

  const directories = new Set<string>([canonical])
  for (const worktree of worktrees) directories.add(worktree.directory)
  for (const session of sessions) directories.add(session.location.directory)

  const grouped = new Map<string, SessionInfo[]>()
  for (const directory of directories) grouped.set(directory, [])
  for (const session of sessions) grouped.get(session.location.directory)?.push(session)

  const nodes = await Promise.all(
    [...directories].map(async (directory): Promise<TreeNode> => {
      const [vcs, shells] = await Promise.all([
        ctx.client.vcs.get({ location: { directory } }).catch(() => undefined),
        ctx.client.shell.list({ location: { directory } }).catch(() => undefined),
      ])
      const owned = grouped.get(directory) ?? []
      const shellCount = shells?.data.length ?? 0
      const anyRunning = owned.some((session) => running.has(session.id))
      return {
        id: `${projectID}:${directory}`,
        directory,
        name: baseName(directory),
        kind: directory === canonical ? "root" : "worktree",
        current: directory === location.directory,
        branch: vcs?.data.branch.current,
        run: shellCount > 0 || anyRunning ? "running" : "idle",
        runningShells: shellCount,
        sessions: forest(owned, running),
      }
    }),
  )

  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "root" ? -1 : 1
    return mostRecent(b) - mostRecent(a)
  })

  return { projectID, canonical, current: location.directory, nodes }
}
