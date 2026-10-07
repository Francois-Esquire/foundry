import {
  BoxRenderable,
  createCliRenderer,
  type RenderContext,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { theme } from "~/components/ui/theme";
import type { StatusReport } from "./model";
import { workspaceLines } from "./text";

export interface StatusProps {
  readonly here?: string;
  readonly report: StatusReport;
}

export function createStatusView(
  context: RenderContext,
  { report, here }: StatusProps
): ScrollBoxRenderable {
  const view = new ScrollBoxRenderable(context, {
    contentOptions: { flexDirection: "column", gap: 1, padding: 1 },
    height: "100%",
    id: "marbles-status",
    scrollX: false,
    width: "100%",
  });
  view.add(
    new TextRenderable(context, {
      attributes: TextAttributes.BOLD,
      content: "MARBLES · workspace status",
      fg: theme.colors.primary,
    })
  );
  view.add(
    new TextRenderable(context, {
      content: "↑/↓ scroll · q or Ctrl+C close",
      fg: theme.colors.mutedForeground,
    })
  );
  if (report.workspaces.length === 0) {
    view.add(
      new TextRenderable(context, {
        content: `no workspaces under ${report.root}`,
        fg: theme.colors.mutedForeground,
      })
    );
  }
  for (const workspace of report.workspaces) {
    const panel = new BoxRenderable(context, {
      border: true,
      borderColor: workspace.alive ? theme.colors.accent : theme.border.color,
      borderStyle: "rounded",
      flexDirection: "column",
      flexShrink: 0,
      id: workspace.id,
      paddingX: 1,
      title: `${workspace.root}${workspace.id === here ? " (here)" : ""}`,
      titleColor: theme.colors.foreground,
    });
    panel.add(
      new TextRenderable(context, {
        content: workspaceLines(workspace).join("\n"),
        fg: theme.colors.foreground,
        wrapMode: "word",
      })
    );
    view.add(panel);
  }
  return view;
}

export async function showStatus(props: StatusProps): Promise<void> {
  const renderer = await createCliRenderer({
    backgroundColor: theme.colors.background,
    exitOnCtrlC: false,
  });
  const closed = new Promise<void>((resolve) => {
    renderer.once("destroy", resolve);
  });
  try {
    const view = createStatusView(renderer, props);
    renderer.root.add(view);
    view.focus();
    renderer.keyInput.on("keypress", (key) => {
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        renderer.destroy();
      }
    });
    await closed;
  } finally {
    renderer.destroy();
  }
}
