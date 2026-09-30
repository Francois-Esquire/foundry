import { unit } from "../geography";
import type {
  FeaturePoint,
  Lake,
  Marsh,
  NaturalFeatures,
  Stream,
} from "../natural-features";
import type { Polygon } from "../types";

/** The chart's shallows pigment, so a lake reads as the same water as the sea. */
const water = "#c3cebd";
const deepWater = "#b3c2b4";
const shoreInk = "#6f8b83";
const streamInk = "#5f8a86";
const bankWash = "#dfe6dc";
const marshWash = "#c9d1b6";
const marshInk = "#7a8a63";
const drainInk = "#956f47";
/** Lake outlines wobble by this fraction of their radius. */
const lakeWobble = 0.12;
const lakeSides = 28;

function trace(ctx: CanvasRenderingContext2D, polygons: Polygon[]) {
  ctx.beginPath();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      ring.forEach(([x, y], i) => {
        if (i) {
          ctx.lineTo(x, y);
        } else {
          ctx.moveTo(x, y);
        }
      });
      ctx.closePath();
    }
  }
}

function path(ctx: CanvasRenderingContext2D, points: FeaturePoint[]) {
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i) {
      ctx.lineTo(p.x, p.y);
    } else {
      ctx.moveTo(p.x, p.y);
    }
  });
}

/** Streams keep their map width far out and thin to a pen line up close. */
function streamLine(stream: Stream, pixels: number) {
  return Math.min(stream.width, (1 + 2 * stream.width) / pixels);
}

function paintStreams(
  ctx: CanvasRenderingContext2D,
  streams: Stream[],
  strength: number,
  pixels: number
) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stream of streams) {
    const line = streamLine(stream, pixels);
    path(ctx, stream.points);
    ctx.globalAlpha = 0.3 * strength;
    ctx.strokeStyle = bankWash;
    ctx.lineWidth = line * 2.2 + 1 / pixels;
    ctx.stroke();
    ctx.globalAlpha = 0.65 * strength;
    ctx.strokeStyle = streamInk;
    ctx.lineWidth = line;
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
    const phase = unit(lake.file.id) * Math.PI * 2;
    ctx.beginPath();
    for (let side = 0; side <= lakeSides; side += 1) {
      const angle = (side / lakeSides) * Math.PI * 2;
      const radius =
        lake.radius *
        (1 +
          lakeWobble * Math.sin(3 * angle + phase) +
          (lakeWobble / 2) * Math.sin(5 * angle - phase));
      const x = lake.file.x + Math.cos(angle) * radius,
        y = lake.file.y + Math.sin(angle) * radius;
      if (side === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.globalAlpha = 0.95 * strength;
    ctx.fillStyle = water;
    ctx.fill();
    ctx.globalAlpha = 0.8 * strength;
    ctx.strokeStyle = shoreInk;
    ctx.lineWidth = 0.8 / pixels;
    ctx.stroke();
    ctx.globalAlpha = 0.6 * strength;
    ctx.fillStyle = deepWater;
    ctx.beginPath();
    ctx.arc(lake.file.x, lake.file.y, lake.radius * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintMarshes(
  ctx: CanvasRenderingContext2D,
  marshes: Marsh[],
  strength: number,
  pixels: number
) {
  for (const marsh of marshes) {
    trace(ctx, marsh.region.polygons);
    ctx.globalAlpha = 0.16 * strength;
    ctx.fillStyle = marshWash;
    ctx.fill("evenodd");
    ctx.globalAlpha = 0.7 * strength;
    ctx.strokeStyle = marshInk;
    ctx.lineWidth = Math.min(0.4, 0.8 / pixels);
    ctx.lineCap = "round";
    ctx.beginPath();
    // The cartographic marsh sign: a waterline with three short reeds.
    for (const tuft of marsh.tufts) {
      ctx.moveTo(tuft.x - 0.9, tuft.y + 0.3);
      ctx.lineTo(tuft.x + 0.9, tuft.y + 0.3);
      ctx.moveTo(tuft.x, tuft.y + 0.1);
      ctx.lineTo(tuft.x, tuft.y - 0.5);
      ctx.moveTo(tuft.x - 0.4, tuft.y + 0.1);
      ctx.lineTo(tuft.x - 0.55, tuft.y - 0.3);
      ctx.moveTo(tuft.x + 0.4, tuft.y + 0.1);
      ctx.lineTo(tuft.x + 0.55, tuft.y - 0.3);
    }
    ctx.stroke();
    const [origin] = marsh.region.members;
    if (!(origin && marsh.drains.length)) {
      continue;
    }
    ctx.globalAlpha = 0.4 * strength;
    ctx.strokeStyle = drainInk;
    ctx.lineWidth = 0.6 / pixels;
    ctx.setLineDash([1 / pixels, 2 / pixels]);
    ctx.beginPath();
    for (const drain of marsh.drains) {
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(drain.x, drain.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function paintConfluences(
  ctx: CanvasRenderingContext2D,
  features: NaturalFeatures,
  strength: number,
  pixels: number
) {
  for (const confluence of features.confluences) {
    const { x, y } = confluence.file;
    ctx.globalAlpha = 0.8 * strength;
    ctx.fillStyle = streamInk;
    ctx.beginPath();
    ctx.arc(x, y, Math.min(1.2, 3.5 / pixels), 0, Math.PI * 2);
    ctx.fill();
    if (confluence.streams > 1) {
      ctx.strokeStyle = streamInk;
      ctx.lineWidth = 0.6 / pixels;
      ctx.beginPath();
      ctx.arc(x, y, Math.min(2.4, 7 / pixels), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/**
 * Draws an island's natural features in island-local coordinates, under the
 * file marks: streams first so lakes and marsh sit on their banks, then
 * confluences where streams meet. Streams and confluences are a layer the
 * chart can switch off; lakes and marsh always draw with the districts.
 */
export function paintNaturalFeatures(
  ctx: CanvasRenderingContext2D,
  features: NaturalFeatures,
  options: { pixels: number; strength: number; streams: boolean }
) {
  const { pixels, strength, streams } = options;
  if (strength <= 0) {
    return;
  }
  ctx.save();
  ctx.setLineDash([]);
  if (streams) {
    paintStreams(ctx, features.streams, strength, pixels);
  }
  paintLakes(ctx, features.lakes, strength, pixels);
  paintMarshes(ctx, features.marshes, strength, pixels);
  if (streams) {
    paintConfluences(ctx, features, strength, pixels);
  }
  ctx.restore();
}
