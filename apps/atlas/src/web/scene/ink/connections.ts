import type { ResponsibilityOverlay } from "../../responsibility-focus";
import type { AtlasData } from "../../types";
import type { InkState } from "./state";

/** The traced imports of the selected file, when Trace imports is on. */
export function paintConnections(state: InkState): void {
  state.ctx.setLineDash([]);
  paintTracedImports(
    state.showConnections,
    state.fileId,
    state.responsibility,
    state.data,
    state.ctx,
    state.pixels
  );
}

function paintTracedImports(
  showConnections: boolean,
  fileId: string | null,
  responsibility: ResponsibilityOverlay | null,
  data: AtlasData,
  ctx: CanvasRenderingContext2D,
  pixels: number
) {
  if (showConnections && fileId && !responsibility) {
    const locations = new Map(
      data.territories.flatMap((p) =>
        p.files.map((f) => [f.id, { x: p.x + f.x, y: p.y + f.y }] as const)
      )
    );
    ctx.strokeStyle = "#8a5a31ba";
    ctx.lineWidth = 1 / pixels;
    ctx.setLineDash([3 / pixels, 5 / pixels]);
    for (const edge of data.fileEdges) {
      if (edge.source !== fileId && edge.target !== fileId) {
        continue;
      }
      const a = locations.get(edge.source),
        b = locations.get(edge.target);
      if (!(a && b)) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}
