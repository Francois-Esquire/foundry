import { marshDetail, riverPen } from "../codex/bindings";
import { unit } from "../geography";
import type { NaturalFeature } from "../natural-feature-inspection";
import type { FeaturePoint, Marsh, NaturalFeatures } from "../natural-features";
import type { RiverRun } from "../river-network";
import { paintLandmarks } from "./paint-landmarks";

const streamInk = "#537d78";
const marshInk = "#697855";

function path(
  ctx: CanvasRenderingContext2D,
  points: FeaturePoint[],
  closed = false
) {
  ctx.beginPath();
  for (const [i, point] of points.entries()) {
    if (i) {
      ctx.lineTo(point.x, point.y);
    } else {
      ctx.moveTo(point.x, point.y);
    }
  }
  if (closed) {
    ctx.closePath();
  }
}

function paintStreams(
  ctx: CanvasRenderingContext2D,
  runs: RiverRun[],
  strength: number,
  pixels: number
) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const run of runs) {
    const width = riverPen(run.width, pixels);
    path(ctx, run.points);
    ctx.globalAlpha = 0.12 * strength;
    ctx.strokeStyle = "#605b47";
    ctx.lineWidth = width + 5 / pixels;
    ctx.stroke();
    ctx.save();
    ctx.translate(0.65 / pixels, 0.9 / pixels);
    path(ctx, run.points);
    ctx.globalAlpha = 0.75 * strength;
    ctx.strokeStyle = "#fff5da";
    ctx.lineWidth = width + 1.3 / pixels;
    ctx.stroke();
    ctx.restore();
    path(ctx, run.points);
    ctx.globalAlpha = 0.85 * strength;
    ctx.strokeStyle = streamInk;
    ctx.lineWidth = width;
    ctx.stroke();
  }
}

function reed(
  ctx: CanvasRenderingContext2D,
  tuft: FeaturePoint,
  pixels: number
) {
  const size = Math.min(1, 5 / pixels);
  const lean = (unit(`${tuft.x}:${tuft.y}`) - 0.5) * 0.35;
  const { x, y } = tuft;
  ctx.moveTo(x - size * 0.85, y + size * 0.3);
  ctx.quadraticCurveTo(x, y + size * 0.4, x + size * 0.85, y + size * 0.22);
  for (const offset of [-0.4, 0, 0.4]) {
    ctx.moveTo(x + offset * size, y + size * 0.1);
    ctx.quadraticCurveTo(
      x + (offset + lean) * size,
      y - size * 0.2,
      x + (offset * 1.35 + lean) * size,
      y - size * (offset ? 0.4 : 0.75)
    );
  }
}

function paintMarshes(
  ctx: CanvasRenderingContext2D,
  marshes: Marsh[],
  strength: number,
  pixels: number
) {
  const detail = marshDetail(marshes.length, pixels);
  const occupied: FeaturePoint[] = [];
  for (const marsh of marshes) {
    ctx.globalAlpha = 0.65 * detail.opacity * strength;
    ctx.strokeStyle = marshInk;
    ctx.lineWidth = Math.min(0.3, 0.75 / pixels);
    ctx.beginPath();
    for (const tuft of marsh.tufts) {
      if (
        occupied.some(
          (point) =>
            Math.hypot(point.x - tuft.x, point.y - tuft.y) < detail.spacing
        )
      ) {
        continue;
      }
      occupied.push(tuft);
      reed(ctx, tuft, pixels);
    }
    ctx.stroke();
    if (pixels < 3) {
      continue;
    }
    ctx.globalAlpha = 0.2 * detail.opacity * strength;
    ctx.lineWidth = 0.6 / pixels;
    ctx.setLineDash([0.7 / pixels, 2.7 / pixels]);
    for (const drain of marsh.drains) {
      path(ctx, drain.points);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

function paintSprings(
  ctx: CanvasRenderingContext2D,
  features: NaturalFeatures,
  strength: number,
  pixels: number
) {
  if (pixels < 2) {
    return;
  }
  const springs = new Map(
    features.streams.map((stream) => [stream.spring.id, stream.spring])
  );
  const landmarks = new Set(
    features.landmarks.map((landmark) => landmark.file.id)
  );
  ctx.strokeStyle = streamInk;
  ctx.lineWidth = 0.7 / pixels;
  ctx.globalAlpha = strength * 0.75;
  for (const spring of springs.values()) {
    if (landmarks.has(spring.id)) {
      continue;
    }
    ctx.beginPath();
    ctx.arc(spring.x, spring.y, 2.2 / pixels, Math.PI * 0.2, Math.PI * 1.8);
    ctx.stroke();
  }
}

function paintFocus(
  ctx: CanvasRenderingContext2D,
  focus: NaturalFeature | undefined,
  pixels: number
) {
  if (!focus) {
    return;
  }
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "#875222";
  ctx.lineWidth = 1.5 / pixels;
  if (focus.kind === "landmark") {
    path(ctx, focus.landmark.footprint, true);
  } else if (focus.kind === "river") {
    path(ctx, focus.river.points);
  } else {
    return;
  }
  ctx.stroke();
}

/** Static cartographic ink. Focus is the only amber in this vocabulary. */
export function paintNaturalFeatures(
  ctx: CanvasRenderingContext2D,
  features: NaturalFeatures,
  options: {
    pixels: number;
    strength: number;
    streams: boolean;
    focus?: NaturalFeature;
  }
) {
  const { pixels, strength, streams, focus } = options;
  if (strength <= 0) {
    return;
  }
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  paintMarshes(ctx, features.marshes, strength, pixels);
  if (streams) {
    paintStreams(ctx, features.rivers, strength, pixels);
  }
  paintLandmarks(ctx, features.landmarks, strength, pixels);
  if (streams) {
    paintSprings(ctx, features, strength, pixels);
  }
  if (focus?.kind !== "river" || streams) {
    paintFocus(ctx, focus, pixels);
  }
  ctx.restore();
}
