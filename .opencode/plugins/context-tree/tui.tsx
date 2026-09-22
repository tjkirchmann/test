import { Plugin } from "@opencode/plugin/tui"
import type { Destination } from "@opencode/plugin/tui/context"
import { TreeView } from "./tree"

const ROUTE = "context-tree"

export default Plugin.define({
  id: "context-tree.tui",
  setup(ctx) {
    const unregisterRoute = ctx.ui.router.register({
      name: ROUTE,
      render: (input) => <TreeView back={input.data?.back as Destination | undefined} />,
    })

    // A slot render runs inside a component, which is where a keymap layer can
    // be created. This is the global entry point into the tree.
    const unregisterSlot = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "context-tree.open",
              title: "Context Tree",
              group: "Context Tree",
              palette: true,
              slash: { name: "tree" },
              run: () => {
                const from = ctx.ui.router.current()
                // `current()` is live: copy the fields into a plain destination
                // now, or the stored value tracks the route instead of a snapshot.
                const back: Destination =
                  from.type === "session"
                    ? { type: "session", sessionID: from.sessionID }
                    : from.type === "plugin" && from.name !== ROUTE
                      ? { type: "plugin", name: from.name }
                      : { type: "home" }
                ctx.ui.router.navigate({ type: "plugin", name: ROUTE, data: { back } })
              },
            },
          ],
        }))
        return null
      },
    })

    ctx.ui.toast.show({ message: "context tree loaded", variant: "success" })

    return () => {
      unregisterRoute()
      unregisterSlot()
    }
  },
})
