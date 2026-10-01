import { marshDetail, riverPen } from "../codex/bindings";
import { unit } from "../geography";
import type { NaturalFeature } from "../natural-feature-inspection";
import type {
  FeaturePoint,
  Lake,
  Marsh,
  NaturalFeatures,
} from "../natural-features";
import type { RiverRun } from "../river-network";

const water = "#c3cebd";
const shoreInk = "#607c70";
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

function paintLakes(
  ctx: CanvasRenderingContext2D,
  lakes: Lake[],
  strength: number,
  pixels: number
) {
  for (const lake of lakes) {
    path(ctx, lake.shore, true);
    ctx.globalAlpha = strength;
    ctx.fillStyle = water;
    ctx.fill();
    ctx.save();
    ctx.clip();
    // An inset bank: shadow at the northwest shore, pale lip at the southeast.
    const spread = Math.min(lake.radius * 0.5, 8 / pixels);
    for (const band of [1, 0.7, 0.4, 0.18]) {
      for (const [direction, color] of [
        [1, "#426e6920"],
        [-1, "#fff6dd32"],
      ] as const) {
        ctx.save();
        const offset = direction * spread * band * 0.3;
        ctx.translate(offset, offset);
        path(ctx, lake.shore, true);
        ctx.strokeStyle = color;
        ctx.lineWidth = spread * band;
        ctx.stroke();
        ctx.restore();
      }
    }
    const wash = ctx.createLinearGradient(
      lake.file.x - lake.radius,
      lake.file.y - lake.radius,
      lake.file.x + lake.radius,
      lake.file.y + lake.radius
    );
    wash.addColorStop(0, "#537f7920");
    wash.addColorStop(1, "#d9e0c300");
    ctx.fillStyle = wash;
    path(ctx, lake.shore, true);
    ctx.fill();
    ctx.restore();
    path(ctx, lake.shore, true);
    ctx.globalAlpha = 0.75 * strength;
    ctx.strokeStyle = shoreInk;
    ctx.lineWidth = 0.65 / pixels;
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
  const lakes = new Set(features.lakes.map((lake) => lake.file.id));
  ctx.strokeStyle = streamInk;
  ctx.lineWidth = 0.7 / pixels;
  ctx.globalAlpha = strength * 0.75;
  for (const spring of springs.values()) {
    if (lakes.has(spring.id)) {
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
  if (focus.kind === "lake") {
    path(ctx, focus.lake.shore, true);
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
  paintLakes(ctx, features.lakes, strength, pixels);
  if (streams) {
    paintSprings(ctx, features, strength, pixels);
  }
  if (focus?.kind !== "river" || streams) {
    paintFocus(ctx, focus, pixels);
  }
  ctx.restore();
}
