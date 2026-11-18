import { type MapFrame, sideOf } from "../maps/map-uniforms";

export const SUBTEXELS = 4;
export const CLIP_CELLS = 512;
const CELL_PIXELS = 4;
const MAX_LEVELS = 8;
const STRIDE_SLACK = 1.3;
const EDGE_STEPS = 2;

export interface ClipLayout {
  readonly levels: number;
  readonly origin: readonly [number, number];
  readonly stride: number;
}

function levelCorner(clip: ClipLayout, level: number): [number, number] {
  const back = (CLIP_CELLS / 2) * clip.stride * (2 ** level - 1);
  return [clip.origin[0] - back, clip.origin[1] - back];
}

function strideFor(wanted: number, previous?: number): number {
  const clamped = Math.max(wanted, 1 / SUBTEXELS);
  if (
    previous !== undefined &&
    clamped >= previous / (Math.SQRT2 * STRIDE_SLACK) &&
    clamped <= previous * Math.SQRT2 * STRIDE_SLACK
  ) {
    return previous;
  }
  return 2 ** Math.max(-Math.log2(SUBTEXELS), Math.round(Math.log2(clamped)));
}

interface Reach {
  readonly high: readonly [number, number];
  readonly low: readonly [number, number];
}

const covers = (clip: ClipLayout, reach: Reach) => {
  const level = clip.levels - 1;
  const [x, y] = levelCorner(clip, level);
  const span = CLIP_CELLS * clip.stride * 2 ** level;
  const beyond = EDGE_STEPS * clip.stride * 2 ** level;
  const spans = (at: number, low: number, high: number) =>
    at <= low - beyond && at + span >= high + beyond;
  return (
    spans(x, reach.low[0], reach.high[0]) &&
    spans(y, reach.low[1], reach.high[1])
  );
};

function reachOf(frame: MapFrame, seabed: MapFrame | undefined): Reach {
  const last = frame.resolution - 1;
  if (!seabed) {
    return { high: [last, last], low: [0, 0] };
  }
  const across = sideOf(seabed) / frame.texel;
  const texelOf = (at: number, origin: number) =>
    (at - origin) / frame.texel - 0.5;
  const lowX = texelOf(seabed.origin[0], frame.origin[0]);
  const lowY = texelOf(seabed.origin[1], frame.origin[1]);
  return {
    high: [Math.max(lowX + across, last), Math.max(lowY + across, last)],
    low: [Math.min(lowX, 0), Math.min(lowY, 0)],
  };
}

export function clipLayout(
  eye: readonly [number, number, number],
  pixel: number,
  frame: MapFrame,
  previous?: number,
  seabed?: MapFrame
): ClipLayout {
  const reach = reachOf(frame, seabed);
  const side = sideOf(frame);
  const under = [
    Math.min(side, Math.max(0, eye[0] - frame.origin[0])) / frame.texel - 0.5,
    Math.min(side, Math.max(0, eye[2] - frame.origin[1])) / frame.texel - 0.5,
  ] as const;
  const height = Math.max(Math.abs(eye[1]), frame.texel);
  const stride = strideFor(
    (CELL_PIXELS * pixel * height) / frame.texel,
    previous
  );
  const span = CLIP_CELLS * stride;
  let clip: ClipLayout = { levels: 1, origin: [0, 0], stride };
  for (let levels = 1; levels <= MAX_LEVELS; levels += 1) {
    const snap = stride * 2 ** (levels - 1);
    clip = {
      levels,
      origin: [
        Math.round((under[0] - span / 2) / snap) * snap,
        Math.round((under[1] - span / 2) / snap) * snap,
      ],
      stride,
    };
    if (covers(clip, reach)) {
      return clip;
    }
  }
  return clip;
}

const vertexId = (x: number, y: number) => y * (CLIP_CELLS + 1) + x;
const centreId = (x: number, y: number) =>
  (CLIP_CELLS + 1) ** 2 + y * CLIP_CELLS + x;

export function levelIndices(ring: boolean): Uint32Array {
  const quarter = CLIP_CELLS / 4;
  const inHole = (x: number, y: number) =>
    ring &&
    x >= quarter &&
    x < CLIP_CELLS - quarter &&
    y >= quarter &&
    y < CLIP_CELLS - quarter;
  const cells = ring ? (CLIP_CELLS ** 2 * 3) / 4 : CLIP_CELLS ** 2;
  const indices = new Uint32Array(cells * 12);
  let at = 0;
  for (let y = 0; y < CLIP_CELLS; y += 1) {
    for (let x = 0; x < CLIP_CELLS; x += 1) {
      if (inHole(x, y)) {
        continue;
      }
      const a = vertexId(x, y);
      const b = vertexId(x + 1, y);
      const c = vertexId(x, y + 1);
      const d = vertexId(x + 1, y + 1);
      const e = centreId(x, y);
      indices.set([a, c, e, c, d, e, d, b, e, b, a, e], at);
      at += 12;
    }
  }
  return indices;
}
