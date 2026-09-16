import {
  BoxRenderable,
  createCliRenderer,
  type RenderContext,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
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
    id: "quirks-status",
    scrollX: false,
    width: "100%",
  });
  view.add(
    new TextRenderable(context, {
      attributes: TextAttributes.BOLD,
      content: "QUIRKS · workspace status",
      fg: "#86d5c3",
    })
  );
  view.add(
    new TextRenderable(context, {
      content: "↑/↓ scroll · q or Ctrl+C close",
      fg: "#8b949e",
    })
  );
  if (report.workspaces.length === 0) {
    view.add(
      new TextRenderable(context, {
        content: `no workspaces under ${report.root}`,
        fg: "#8b949e",
      })
    );
  }
  for (const workspace of report.workspaces) {
    const panel = new BoxRenderable(context, {
      border: true,
      borderColor: workspace.alive ? "#86d5c3" : "#485460",
      borderStyle: "rounded",
      flexDirection: "column",
      flexShrink: 0,
      id: workspace.id,
      paddingX: 1,
      title: `${workspace.root}${workspace.id === here ? " (here)" : ""}`,
      titleColor: "#e6edf3",
    });
    panel.add(
      new TextRenderable(context, {
        content: workspaceLines(workspace).join("\n"),
        fg: "#c9d1d9",
        wrapMode: "word",
      })
    );
    view.add(panel);
  }
  return view;
}

export async function showStatus(props: StatusProps): Promise<void> {
  const renderer = await createCliRenderer({
    backgroundColor: "#111820",
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
