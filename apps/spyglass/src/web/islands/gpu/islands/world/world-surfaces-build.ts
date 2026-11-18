import type { Point } from "../../../data/chart";
import type { Parcel, ParcelKind, Road, RoadRank, WorldPlan } from "./world";

const ROAD_RANKS: readonly RoadRank[] = ["main", "street", "lane", "path"];
const DISC_RANK = 4;

const PARCEL_KINDS: readonly ParcelKind[] = [
  "lot",
  "plaza",
  "pitch",
  "playground",
  "track",
  "field",
  "garden",
  "shrine",
  "parking",
];

const SURFACE_LIFT = {
  disc: 0.03,
  lane: 0.022,
  main: 0.026,
  pad: 0.014,
  path: 0.02,
  street: 0.024,
} as const;
const BRANCH_DIP = 0.006;

const ROAD_SHOULDER = 0.2;
const ALONG_STEP = 1;
const BRANCH_OVERLAP = 0.2;
const JOIN_TOLERANCE = 0.2;
const MIN_JOIN_SINE = 0.3;
const FILLET_SHARE = 0.35;
const FILLET_LIMITS = [0.15, 0.6] as const;
const FILLET_REACH = 2;
const MITRE_LIMIT = 2;
const DISC_REACH = 1.15;
const DISC_SEGMENTS = 20;
const DISC_RIM = 0.05;
const SCHOOL_REACH = 15;

const PAD_STEP = 1;
const PAD_MITRE_LIMIT = 2.5;

const GAP_FLOATS = 8;
const SCHOOL_FLAG = 1;

export interface PackedSurfaces {
  readonly gaps: Float32Array<ArrayBuffer>;
  readonly joints: number;
  readonly junctions: number;
  readonly outlines: Float32Array<ArrayBuffer>;
  readonly pads: Float32Array<ArrayBuffer>;
  readonly padVertices: number;
  readonly parcels: Float32Array<ArrayBuffer>;
  readonly ribbons: Float32Array<ArrayBuffer>;
  readonly ribbonVertices: number;
  readonly roads: Float32Array<ArrayBuffer>;
}

type Vec = readonly [number, number];

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec, b: Vec) => a[0] * b[1] - a[1] * b[0];
const length = (a: Vec) => Math.hypot(a[0], a[1]);
const unit = (a: Vec): Vec => {
  const l = length(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l] : [1, 0];
};
const perp = (a: Vec): Vec => [-a[1], a[0]];

class Floats {
  data = new Float32Array(1024);
  size = 0;
  push(...values: number[]) {
    if (this.size + values.length > this.data.length) {
      const grown = new Float32Array(
        Math.max(this.data.length * 2, this.size + values.length)
      );
      grown.set(this.data);
      this.data = grown;
    }
    this.data.set(values, this.size);
    this.size += values.length;
  }
  done(): Float32Array<ArrayBuffer> {
    const out = new Float32Array(Math.max(this.size, 4));
    out.set(this.data.subarray(0, this.size));
    return out;
  }
}

interface Line {
  readonly along: readonly number[];
  readonly length: number;
  readonly points: readonly Vec[];
}

function lineOf(points: readonly Point[]): Line {
  const kept: Vec[] = [];
  for (const p of points) {
    const last = kept.at(-1);
    if (!last || length(sub(p, last)) > 1e-4) {
      kept.push([p[0], p[1]]);
    }
  }
  const along = [0];
  for (let i = 1; i < kept.length; i += 1) {
    along.push(
      (along[i - 1] ?? 0) + length(sub(kept[i] as Vec, kept[i - 1] as Vec))
    );
  }
  return { along, length: along.at(-1) ?? 0, points: kept };
}

function boxOf(
  points: readonly Point[],
  margin: number
): [number, number, number, number] {
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  return [
    Math.min(...xs) - margin,
    Math.min(...zs) - margin,
    Math.max(...xs) + margin,
    Math.max(...zs) + margin,
  ];
}

interface Nearest {
  readonly along: number;
  readonly at: Vec;
  readonly distance: number;
  readonly tangent: Vec;
}

function nearestOn(line: Line, p: Vec): Nearest | null {
  let best: Nearest | null = null;
  for (let i = 1; i < line.points.length; i += 1) {
    const a = line.points[i - 1] as Vec;
    const b = line.points[i] as Vec;
    const ab = sub(b, a);
    const span = dot(ab, ab);
    const t =
      span > 0 ? Math.min(Math.max(dot(sub(p, a), ab) / span, 0), 1) : 0;
    const at = add(a, scale(ab, t));
    const distance = length(sub(p, at));
    if (!best || distance < best.distance) {
      best = {
        along: (line.along[i - 1] ?? 0) + t * Math.sqrt(span),
        at,
        distance,
        tangent: unit(ab),
      };
    }
  }
  return best;
}

function pointAlong(line: Line, distance: number): { at: Vec; tangent: Vec } {
  const d = Math.min(Math.max(distance, 0), line.length);
  for (let i = 1; i < line.points.length; i += 1) {
    const end = line.along[i] ?? 0;
    if (d <= end || i === line.points.length - 1) {
      const start = line.along[i - 1] ?? 0;
      const a = line.points[i - 1] as Vec;
      const b = line.points[i] as Vec;
      const t = end > start ? (d - start) / (end - start) : 0;
      return { at: add(a, scale(sub(b, a), t)), tangent: unit(sub(b, a)) };
    }
  }
  return { at: line.points[0] ?? [0, 0], tangent: [1, 0] };
}

interface Section {
  readonly along: number;
  readonly centre: Vec;
  readonly dir: Vec;
  readonly lift: number;
  readonly slope: number;
}

interface Cut {
  readonly across: Vec;
  readonly endAlong: number;
  readonly into: Vec;
  readonly junction: Vec;
  readonly normal: Vec;
  readonly tangent: Vec;
  readonly throughHalf: number;
  readonly throughLift: number;
}

function cutSection(
  cut: Cut,
  y: number,
  lift: number,
  atEnd: boolean
): Section {
  const sine = Math.max(dot(scale(cut.into, -1), cut.normal), MIN_JOIN_SINE);
  const k = dot(cut.across, cut.normal) / sine;
  const back = y / sine;
  const centre = sub(cut.junction, scale(cut.into, back));
  const dir = add(cut.across, scale(cut.into, k));
  const sign = atEnd ? 1 : -1;
  return {
    along: cut.endAlong - sign * back,
    centre,
    dir,
    lift,
    slope: sign * k,
  };
}

interface RoadInfo {
  readonly box: readonly [number, number, number, number];
  readonly half: number;
  readonly lift: number;
  readonly line: Line;
  readonly road: Road;
}

interface Junction {
  readonly crossLift: number;
  readonly cut: Cut;
  readonly end: 0 | 1;
  readonly endLift: number;
  readonly through: RoadInfo;
}

const liftOf = (rank: RoadRank) => SURFACE_LIFT[rank];

function filletOf(a: number, b: number): number {
  const share = FILLET_SHARE * Math.min(a, b);
  return Math.min(Math.max(share, FILLET_LIMITS[0]), FILLET_LIMITS[1]);
}

function sectionsOf(info: RoadInfo, from: number, to: number): Section[] {
  const { line, lift } = info;
  const { points } = line;
  const sections: Section[] = [];
  const last = points.length - 1;
  for (let i = 0; i <= last; i += 1) {
    const d = line.along[i] ?? 0;
    if (d < from || d > to) {
      continue;
    }
    const p = points[i] as Vec;
    const before = unit(sub(p, points[Math.max(i - 1, 0)] as Vec));
    const after = unit(sub(points[Math.min(i + 1, last)] as Vec, p));
    const into = i === 0 ? after : before;
    const out = i === last ? before : after;
    const bisector = unit(add(perp(into), perp(out)));
    const cosine = Math.max(dot(bisector, perp(out)), 1 / MITRE_LIMIT);
    sections.push({
      along: d,
      centre: p,
      dir: scale(bisector, 1 / cosine),
      lift,
      slope: 0,
    });
  }
  return sections;
}

function sectionAt(info: RoadInfo, distance: number): Section {
  const { at, tangent } = pointAlong(info.line, distance);
  return {
    along: distance,
    centre: at,
    dir: perp(tangent),
    lift: info.lift,
    slope: 0,
  };
}

class RibbonWriter {
  readonly vertices = new Floats();
  count = 0;

  strip(
    sections: readonly Section[],
    index: number,
    half: number,
    outer: number
  ) {
    const columns = [-outer, -half, 0, half, outer];
    const expand = [true, false, false, false, true];
    for (let i = 1; i < sections.length; i += 1) {
      const a = sections[i - 1] as Section;
      const b = sections[i] as Section;
      const span = Math.abs(b.along - a.along);
      const steps = Math.max(Math.ceil(span / ALONG_STEP), 1);
      for (let k = 0; k < steps; k += 1) {
        const s0 = lerpSection(a, b, k / steps);
        const s1 = lerpSection(a, b, (k + 1) / steps);
        for (let c = 1; c < columns.length; c += 1) {
          const left = columns[c - 1] as number;
          const right = columns[c] as number;
          const el = expand[c - 1] as boolean;
          const er = expand[c] as boolean;
          this.vertex(s0, left, index, el);
          this.vertex(s1, left, index, el);
          this.vertex(s1, right, index, er);
          this.vertex(s0, left, index, el);
          this.vertex(s1, right, index, er);
          this.vertex(s0, right, index, er);
        }
      }
    }
  }

  vertex(s: Section, a: number, index: number, expand: boolean) {
    const p = add(s.centre, scale(s.dir, a));
    this.vertices.push(
      p[0],
      p[1],
      s.along + s.slope * a,
      a,
      s.dir[0],
      s.dir[1],
      s.lift,
      index * 2 + (expand ? 1 : 0)
    );
    this.count += 1;
  }

  disc(centre: Vec, radius: number, lift: number, index: number) {
    for (let k = 0; k < DISC_SEGMENTS; k += 1) {
      const a0 = (k / DISC_SEGMENTS) * Math.PI * 2;
      const a1 = ((k + 1) / DISC_SEGMENTS) * Math.PI * 2;
      const d0: Vec = [Math.cos(a0), Math.sin(a0)];
      const d1: Vec = [Math.cos(a1), Math.sin(a1)];
      const rim = radius + DISC_RIM;
      const ring = (d: Vec, r: number, expand: boolean) => {
        const p = add(centre, scale(d, r));
        this.vertices.push(
          p[0],
          p[1],
          0,
          r,
          d[0],
          d[1],
          lift,
          index * 2 + (expand ? 1 : 0)
        );
        this.count += 1;
      };
      ring(d0, 0, false);
      ring(d0, radius, false);
      ring(d1, radius, false);
      ring(d0, radius, false);
      ring(d0, rim, true);
      ring(d1, rim, true);
      ring(d0, radius, false);
      ring(d1, rim, true);
      ring(d1, radius, false);
    }
  }
}

function lerpSection(a: Section, b: Section, t: number): Section {
  const mix = (x: number, y: number) => x + (y - x) * t;
  return {
    along: mix(a.along, b.along),
    centre: [mix(a.centre[0], b.centre[0]), mix(a.centre[1], b.centre[1])],
    dir: [mix(a.dir[0], b.dir[0]), mix(a.dir[1], b.dir[1])],
    lift: mix(a.lift, b.lift),
    slope: mix(a.slope, b.slope),
  };
}

type Meeting =
  | { readonly kind: "through"; readonly other: RoadInfo; readonly at: Nearest }
  | { readonly kind: "joint" }
  | null;

function meetingOf(
  info: RoadInfo,
  end: 0 | 1,
  infos: readonly RoadInfo[]
): Meeting {
  const { line } = info;
  const p = (end === 0 ? line.points[0] : line.points.at(-1)) as Vec;
  const ownAlong = end === 0 ? 0 : line.length;
  let through: { other: RoadInfo; at: Nearest } | null = null;
  let joint = false;
  for (const other of infos) {
    const [x0, z0, x1, z1] = other.box;
    if (p[0] < x0 || p[0] > x1 || p[1] < z0 || p[1] > z1) {
      continue;
    }
    const at = nearestOn(other.line, p);
    if (!at || at.distance > JOIN_TOLERANCE) {
      continue;
    }
    if (other === info && Math.abs(at.along - ownAlong) < 2 * info.half + 2) {
      continue;
    }
    const nearEnd = Math.min(at.along, other.line.length - at.along);
    if (nearEnd < info.half) {
      joint = true;
      continue;
    }
    if (!through || other.half > through.other.half) {
      through = { at, other };
    }
  }
  if (through) {
    return { kind: "through", ...through };
  }
  return joint ? { kind: "joint" } : null;
}

interface GapRecord {
  readonly end: number;
  readonly fillet: number;
  readonly side: number;
  readonly start: number;
  readonly way: Vec;
  readonly wayEnd: Vec;
}

function schoolsOf(plan: WorldPlan): Vec[] {
  return plan.buildings
    .filter((b) => b.kind === "school")
    .map((b) => [b.at[0], b.at[1]] as Vec);
}

function nearSchool(line: Line, schools: readonly Vec[]): boolean {
  return schools.some((s) =>
    line.points.some((p) => length(sub(p, s)) < SCHOOL_REACH)
  );
}

function quietOf(info: RoadInfo, cut: Cut): number {
  return FILLET_REACH * filletOf(info.road.width, cut.throughHalf * 2) + 0.1;
}

function drawOrder(
  infos: readonly RoadInfo[],
  junctionsOf: ReadonlyMap<RoadInfo, readonly Junction[]>
): RoadInfo[] {
  const depth = new Map<RoadInfo, number>(infos.map((info) => [info, 0]));
  const joins: [RoadInfo, RoadInfo][] = [];
  for (const [branch, ends] of junctionsOf) {
    for (const j of ends) {
      joins.push([branch, j.through]);
    }
  }
  let passes = infos.length;
  while (passes > 0) {
    passes -= 1;
    let moved = false;
    for (const [branch, through] of joins) {
      const above = (depth.get(branch) ?? 0) + 1;
      if (above > (depth.get(through) ?? 0) && above <= infos.length) {
        depth.set(through, above);
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }
  return [...infos].sort(
    (a, b) =>
      (depth.get(a) ?? 0) - (depth.get(b) ?? 0) ||
      a.lift - b.lift ||
      a.road.id - b.road.id
  );
}

const endKey = (info: RoadInfo, end: 0 | 1) => `${info.road.id}:${end}`;

function waysAt(info: RoadInfo, end: 0 | 1): { travel: Vec; away: Vec } {
  const pts = info.line.points;
  const n = pts.length;
  if (end === 0) {
    const away = unit(sub(pts[1] as Vec, pts[0] as Vec));
    return { away, travel: away };
  }
  const into = unit(sub(pts[n - 1] as Vec, pts[n - 2] as Vec));
  return { away: scale(into, -1), travel: into };
}

function jointsOf(ends: readonly { info: RoadInfo; end: 0 | 1; at: Vec }[]): {
  mitres: Map<string, Section>;
  discs: { at: Vec; radius: number }[];
} {
  const groups: { at: Vec; members: (typeof ends)[number][] }[] = [];
  for (const e of ends) {
    const group = groups.find((g) => length(sub(g.at, e.at)) < JOIN_TOLERANCE);
    if (group) {
      group.members.push(e);
    } else {
      groups.push({ at: e.at, members: [e] });
    }
  }
  const mitres = new Map<string, Section>();
  const discs: { at: Vec; radius: number }[] = [];
  for (const { at, members } of groups) {
    const [a, b] = members;
    const sections =
      members.length === 2 && a && b
        ? [mitreOf(a, b, members), mitreOf(b, a, members)]
        : [];
    if (sections[0] && sections[1] && a && b) {
      mitres.set(endKey(a.info, a.end), sections[0]);
      mitres.set(endKey(b.info, b.end), sections[1]);
      continue;
    }
    discs.push({ at, radius: Math.max(...members.map((m) => m.info.half)) });
  }
  return { discs, mitres };
}

function mitreOf(
  own: { info: RoadInfo; end: 0 | 1; at: Vec },
  other: { info: RoadInfo; end: 0 | 1; at: Vec },
  both: readonly { at: Vec }[]
): Section | null {
  const { travel } = waysAt(own.info, own.end);
  const on = waysAt(other.info, other.end).away;
  const into = own.end === 1 ? travel : scale(on, -1);
  const out = own.end === 1 ? on : travel;
  const bisector = unit(add(perp(into), perp(out)));
  const cosine = dot(bisector, perp(out));
  if (cosine < 1 / MITRE_LIMIT) {
    return null;
  }
  const dir = scale(bisector, 1 / cosine);
  const centre = scale(
    both.reduce((m, e) => add(m, e.at), [0, 0] as Vec),
    1 / both.length
  );
  return {
    along: own.end === 1 ? own.info.line.length : 0,
    centre,
    dir,
    lift: own.info.lift,
    slope: dot(dir, travel),
  };
}

interface RoadsOut {
  readonly gaps: Floats;
  readonly joints: number;
  readonly junctions: number;
  readonly roads: Floats;
  readonly writer: RibbonWriter;
}

function junctionAt(
  info: RoadInfo,
  end: 0 | 1,
  other: RoadInfo,
  at: Nearest
): { junction: Junction; gap: GapRecord } {
  const reach = Math.min(other.half + info.half + 1, info.line.length);
  const back = pointAlong(
    info.line,
    end === 0 ? reach : info.line.length - reach
  ).at;
  const into = unit(sub(at.at, back));
  const flip = dot(scale(into, -1), perp(at.tangent)) < 0;
  const normal = flip ? scale(perp(at.tangent), -1) : perp(at.tangent);
  const side = flip ? -1 : 1;
  const cut: Cut = {
    across: perp(end === 1 ? into : scale(into, -1)),
    endAlong: end === 1 ? info.line.length : 0,
    into,
    junction: at.at,
    normal,
    tangent: at.tangent,
    throughHalf: other.half,
    throughLift: other.lift,
  };
  const junction: Junction = {
    crossLift: Math.min(info.lift, other.lift) - BRANCH_DIP / 2,
    cut,
    end,
    endLift: other.lift - BRANCH_DIP,
    through: other,
  };
  const edge = cutSection(cut, other.half, 0, end === 1);
  const away = scale(into, -1);
  const corners = [-info.half, info.half]
    .map((a) => {
      const corner = add(edge.centre, scale(edge.dir, a));
      const near = nearestOn(other.line, corner) ?? at;
      const out = scale(perp(near.tangent), side);
      return {
        along: near.along,
        way: [dot(away, near.tangent), dot(away, out)] as Vec,
      };
    })
    .sort((x, y) => x.along - y.along);
  const [low, high] = corners as [
    (typeof corners)[number],
    (typeof corners)[number],
  ];
  return {
    gap: {
      end: high.along,
      fillet: filletOf(info.road.width, other.road.width),
      side,
      start: low.along,
      way: low.way,
      wayEnd: high.way,
    },
    junction,
  };
}

interface Meetings {
  readonly gapsOf: Map<RoadInfo, GapRecord[]>;
  readonly jointEnds: { info: RoadInfo; end: 0 | 1; at: Vec }[];
  junctions: number;
  readonly junctionsOf: Map<RoadInfo, Junction[]>;
}

function meetingsOf(infos: readonly RoadInfo[]): Meetings {
  const found: Meetings = {
    gapsOf: new Map(),
    jointEnds: [],
    junctions: 0,
    junctionsOf: new Map(),
  };
  for (const info of infos) {
    const own: Junction[] = [];
    for (const end of [0, 1] as const) {
      const meeting = meetingOf(info, end, infos);
      if (meeting?.kind === "joint") {
        const at = (
          end === 0 ? info.line.points[0] : info.line.points.at(-1)
        ) as Vec;
        found.jointEnds.push({ at, end, info });
      } else if (meeting?.kind === "through") {
        const { junction, gap } = junctionAt(
          info,
          end,
          meeting.other,
          meeting.at
        );
        own.push(junction);
        const gaps = found.gapsOf.get(meeting.other) ?? [];
        gaps.push(gap);
        found.gapsOf.set(meeting.other, gaps);
        found.junctions += 1;
      }
    }
    found.junctionsOf.set(info, own);
  }
  return found;
}

function branchEnd(
  info: RoadInfo,
  j: Junction,
  outer: number
): { sections: Section[]; limit: number; records: GapRecord[] } {
  const atEnd = j.end === 1;
  const { cut } = j;
  const edge = cutSection(cut, cut.throughHalf, j.crossLift, atEnd);
  const overlap = Math.min(BRANCH_OVERLAP, cut.throughHalf * 0.6);
  const tip = cutSection(cut, cut.throughHalf - overlap, j.endLift, atEnd);
  const sign = atEnd ? -1 : 1;
  const limit = edge.along + sign * (Math.abs(edge.slope) * outer + 0.05);
  const quiet = quietOf(info, cut);
  const records = [-1, 1].map((side) => ({
    end: atEnd ? 1e6 : limit + quiet,
    fillet: -1,
    side,
    start: atEnd ? limit - quiet : -1e3,
    way: [0, 1] as Vec,
    wayEnd: [0, 1] as Vec,
  }));
  return { limit, records, sections: atEnd ? [edge, tip] : [tip, edge] };
}

function plainSections(
  info: RoadInfo,
  from: number,
  to: number,
  mitres: ReadonlyMap<string, Section>,
  cut: { start: boolean; finish: boolean }
): Section[] {
  if (to <= from) {
    return [];
  }
  const regular = sectionsOf(info, from, to);
  const first = mitres.get(endKey(info, 0));
  const last = mitres.get(endKey(info, 1));
  if (first && regular[0]?.along === 0) {
    regular[0] = first;
  }
  if (last && regular.at(-1)?.along === info.line.length) {
    regular[regular.length - 1] = last;
  }
  if (cut.start && (regular[0]?.along ?? to) > from + 1e-3) {
    regular.unshift(sectionAt(info, from));
  }
  if (cut.finish && (regular.at(-1)?.along ?? from) < to - 1e-3) {
    regular.push(sectionAt(info, to));
  }
  return regular;
}

function ribbonOf(
  info: RoadInfo,
  ends: readonly Junction[],
  mitres: ReadonlyMap<string, Section>,
  outer: number
): { sections: Section[]; records: GapRecord[] } {
  const start = ends.find((j) => j.end === 0);
  const finish = ends.find((j) => j.end === 1);
  const head = start ? branchEnd(info, start, outer) : null;
  const tail = finish ? branchEnd(info, finish, outer) : null;
  const from = head?.limit ?? 0;
  const to = tail?.limit ?? info.line.length;
  const sections = [
    ...(head?.sections ?? []),
    ...plainSections(info, from, to, mitres, {
      finish: Boolean(finish),
      start: Boolean(start),
    }),
    ...(tail?.sections ?? []),
  ];
  const lowered = sections.map((section) => {
    const low = ends
      .filter((j) =>
        j.end === 0
          ? section.along <= from + quietOf(info, j.cut)
          : section.along >= to - quietOf(info, j.cut)
      )
      .map((j) => j.crossLift);
    return low.length > 0
      ? { ...section, lift: Math.min(section.lift, ...low) }
      : section;
  });
  return {
    records: [...(head?.records ?? []), ...(tail?.records ?? [])],
    sections: lowered,
  };
}

function packRoads(plan: WorldPlan): RoadsOut {
  const infos: RoadInfo[] = plan.roads
    .map((road) => ({
      box: boxOf(road.points, JOIN_TOLERANCE),
      half: road.width / 2,
      lift: liftOf(road.rank),
      line: lineOf(road.points),
      road,
    }))
    .filter((info) => info.line.points.length >= 2);
  const { gapsOf, jointEnds, junctionsOf, junctions } = meetingsOf(infos);
  const { mitres, discs } = jointsOf(jointEnds);
  const schools = schoolsOf(plan);
  const writer = new RibbonWriter();
  const roads = new Floats();
  const gaps = new Floats();
  let index = 0;
  for (const info of drawOrder(infos, junctionsOf)) {
    const own = gapsOf.get(info) ?? [];
    const fillet = Math.max(0, ...own.map((g) => g.fillet));
    const outer =
      info.half + Math.max(ROAD_SHOULDER, FILLET_REACH * fillet + 0.05);
    const ribbon = ribbonOf(info, junctionsOf.get(info) ?? [], mitres, outer);
    const records = [...own, ...ribbon.records];
    writer.strip(ribbon.sections, index, info.half, outer);
    const flags =
      info.road.rank === "lane" && nearSchool(info.line, schools)
        ? SCHOOL_FLAG
        : 0;
    roads.push(
      info.half,
      ROAD_RANKS.indexOf(info.road.rank),
      gaps.size / GAP_FLOATS,
      records.length,
      flags,
      info.line.length,
      info.road.id,
      0
    );
    for (const g of records) {
      gaps.push(g.start, g.end, g.side, g.fillet, ...g.way, ...g.wayEnd);
    }
    index += 1;
  }
  for (const disc of discs) {
    const radius = disc.radius * DISC_REACH;
    writer.disc(disc.at, radius, SURFACE_LIFT.disc, index);
    roads.push(radius, DISC_RANK, 0, 0, 0, 0, 0, 0);
    index += 1;
  }
  return {
    gaps,
    joints: mitres.size / 2 + discs.length,
    junctions,
    roads,
    writer,
  };
}

interface Frame {
  readonly centre: Vec;
  readonly x: Vec;
  readonly z: Vec;
}

const toLocal = (f: Frame, p: Vec): Vec => {
  const d = sub(p, f.centre);
  return [dot(d, f.x), dot(d, f.z)];
};
const toWorld = (f: Frame, l: Vec): Vec =>
  add(f.centre, add(scale(f.x, l[0]), scale(f.z, l[1])));

function signedArea(points: readonly Vec[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    area += cross(points[i] as Vec, points[(i + 1) % points.length] as Vec);
  }
  return area / 2;
}

function frameOf(parcel: Parcel, roads: readonly Line[]): Frame {
  const pts = parcel.outline.map((p) => [p[0], p[1]] as Vec);
  const road = parcel.road === null ? undefined : roads[parcel.road];
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i] as Vec;
    const b = pts[(i + 1) % pts.length] as Vec;
    const middle = scale(add(a, b), 0.5);
    const score = road
      ? (nearestOn(road, middle)?.distance ?? 0) - 1e-3 * length(sub(b, a))
      : -length(sub(b, a));
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  const a = pts[best] as Vec;
  const b = pts[(best + 1) % pts.length] as Vec;
  const x = unit(sub(b, a));
  const mid = pts.reduce((m, p) => add(m, scale(p, 1 / pts.length)), [
    0, 0,
  ] as Vec);
  let z = perp(x);
  if (dot(sub(scale(add(a, b), 0.5), mid), z) < 0) {
    z = scale(z, -1);
  }
  const probe: Frame = { centre: mid, x, z };
  const local = pts.map((p) => toLocal(probe, p));
  const middle = (axis: 0 | 1) =>
    (Math.min(...local.map((p) => p[axis])) +
      Math.max(...local.map((p) => p[axis]))) /
    2;
  const centre = toWorld(probe, [middle(0), middle(1)]);
  return { centre, x, z };
}

function clipAxis(
  polygon: readonly Vec[],
  axis: 0 | 1,
  value: number,
  keepAbove: boolean
): Vec[] {
  const out: Vec[] = [];
  const inside = (p: Vec) => (keepAbove ? p[axis] >= value : p[axis] <= value);
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Vec;
    const b = polygon[(i + 1) % polygon.length] as Vec;
    const ina = inside(a);
    const inb = inside(b);
    if (ina) {
      out.push(a);
    }
    if (ina !== inb) {
      const t = (value - a[axis]) / (b[axis] - a[axis]);
      out.push(add(a, scale(sub(b, a), t)));
    }
  }
  return out;
}

function earClip(polygon: readonly Vec[]): Vec[][] {
  const pts = [...polygon];
  const triangles: Vec[][] = [];
  let guard = pts.length * pts.length + 8;
  while (pts.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[(i + pts.length - 1) % pts.length] as Vec;
      const b = pts[i] as Vec;
      const c = pts[(i + 1) % pts.length] as Vec;
      if (cross(sub(b, a), sub(c, b)) <= 1e-12) {
        continue;
      }
      const blocked = pts.some(
        (p) =>
          p !== a &&
          p !== b &&
          p !== c &&
          cross(sub(b, a), sub(p, a)) > 0 &&
          cross(sub(c, b), sub(p, b)) > 0 &&
          cross(sub(a, c), sub(p, c)) > 0
      );
      if (blocked) {
        continue;
      }
      triangles.push([a, b, c]);
      pts.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      pts.splice(0, 1);
    }
  }
  if (pts.length === 3 && Math.abs(signedArea(pts)) > 1e-10) {
    triangles.push(pts);
  }
  return triangles;
}

function gridCrossings(a: Vec, b: Vec, origin: Vec): number[] {
  const ts: number[] = [];
  for (const axis of [0, 1] as const) {
    const lo = Math.min(a[axis], b[axis]);
    const hi = Math.max(a[axis], b[axis]);
    const first = Math.ceil((lo - origin[axis]) / PAD_STEP);
    for (let k = first; origin[axis] + k * PAD_STEP < hi; k += 1) {
      const v = origin[axis] + k * PAD_STEP;
      const t = (v - a[axis]) / (b[axis] - a[axis]);
      if (t > 1e-6 && t < 1 - 1e-6) {
        ts.push(t);
      }
    }
  }
  return ts.sort((x, y) => x - y);
}

class PadWriter {
  readonly vertices = new Floats();
  count = 0;

  vertex(p: Vec, dir: Vec, index: number) {
    this.vertices.push(
      p[0],
      p[1],
      dir[0],
      dir[1],
      SURFACE_LIFT.pad,
      index,
      0,
      0
    );
    this.count += 1;
  }

  pad(frame: Frame, local: readonly Vec[], index: number) {
    const origin: Vec = [
      Math.min(...local.map((p) => p[0])),
      Math.min(...local.map((p) => p[1])),
    ];
    this.inside(frame, local, origin, index);
    this.skirt(frame, local, origin, index);
  }

  inside(frame: Frame, local: readonly Vec[], origin: Vec, index: number) {
    const reach = (axis: 0 | 1) =>
      Math.max(
        Math.ceil(
          (Math.max(...local.map((p) => p[axis])) - origin[axis]) / PAD_STEP
        ),
        1
      );
    const cells = [reach(0), reach(1)] as const;
    for (let i = 0; i < cells[0]; i += 1) {
      for (let j = 0; j < cells[1]; j += 1) {
        const x0 = origin[0] + i * PAD_STEP;
        const z0 = origin[1] + j * PAD_STEP;
        let piece: Vec[] = [...local];
        piece = clipAxis(piece, 0, x0, true);
        piece = clipAxis(piece, 0, x0 + PAD_STEP, false);
        piece = clipAxis(piece, 1, z0, true);
        piece = clipAxis(piece, 1, z0 + PAD_STEP, false);
        if (piece.length < 3 || Math.abs(signedArea(piece)) < 1e-8) {
          continue;
        }
        for (const p of earClip(piece).flat()) {
          this.vertex(toWorld(frame, p), NO_SKIRT, index);
        }
      }
    }
  }

  skirt(frame: Frame, local: readonly Vec[], origin: Vec, index: number) {
    const n = local.length;
    const normals = local.map((a, k) => {
      const e = unit(sub(local[(k + 1) % n] as Vec, a));
      return [e[1], -e[0]] as Vec;
    });
    const mitres = local.map((_, k) => {
      const after = normals[k] as Vec;
      const m = unit(add(normals[(k + n - 1) % n] as Vec, after));
      return scale(m, 1 / Math.max(dot(m, after), 1 / PAD_MITRE_LIMIT));
    });
    const worldDir = (d: Vec): Vec =>
      add(scale(frame.x, d[0]), scale(frame.z, d[1]));
    for (let k = 0; k < n; k += 1) {
      const a = local[k] as Vec;
      const b = local[(k + 1) % n] as Vec;
      const ts = [0, ...gridCrossings(a, b, origin), 1];
      const outAt = (t: number): Vec => {
        if (t === 0) {
          return worldDir(mitres[k] as Vec);
        }
        return worldDir((t === 1 ? mitres[(k + 1) % n] : normals[k]) as Vec);
      };
      for (let s = 1; s < ts.length; s += 1) {
        const t0 = ts[s - 1] as number;
        const t1 = ts[s] as number;
        const w0 = toWorld(frame, add(a, scale(sub(b, a), t0)));
        const w1 = toWorld(frame, add(a, scale(sub(b, a), t1)));
        const d0 = outAt(t0);
        const d1 = outAt(t1);
        this.vertex(w0, NO_SKIRT, index);
        this.vertex(w1, NO_SKIRT, index);
        this.vertex(w1, d1, index);
        this.vertex(w0, NO_SKIRT, index);
        this.vertex(w1, d1, index);
        this.vertex(w0, d0, index);
      }
    }
  }
}

const NO_SKIRT: Vec = [0, 0];

interface PadsOut {
  readonly outlines: Floats;
  readonly parcels: Floats;
  readonly writer: PadWriter;
}

function packPads(plan: WorldPlan): PadsOut {
  const lines = plan.roads.map((r) => lineOf(r.points));
  const writer = new PadWriter();
  const parcels = new Floats();
  const outlines = new Floats();
  let index = 0;
  for (const parcel of plan.parcels) {
    if (parcel.outline.length < 3) {
      continue;
    }
    const frame = frameOf(parcel, lines);
    let local = parcel.outline.map((p) => toLocal(frame, [p[0], p[1]]));
    if (signedArea(local) < 0) {
      local = local.reverse();
    }
    const xs = local.map((p) => p[0]);
    const zs = local.map((p) => p[1]);
    const half: Vec = [
      (Math.max(...xs) - Math.min(...xs)) / 2,
      (Math.max(...zs) - Math.min(...zs)) / 2,
    ];
    parcels.push(
      frame.centre[0],
      frame.centre[1],
      frame.x[0],
      frame.x[1],
      frame.z[0],
      frame.z[1],
      half[0],
      half[1],
      PARCEL_KINDS.indexOf(parcel.kind),
      parcel.id,
      outlines.size / 2,
      local.length
    );
    for (const p of local) {
      outlines.push(p[0], p[1]);
    }
    writer.pad(frame, local, index);
    index += 1;
  }
  return { outlines, parcels, writer };
}

export function packSurfaces(plan: WorldPlan): PackedSurfaces {
  const roads = packRoads(plan);
  const pads = packPads(plan);
  return {
    gaps: roads.gaps.done(),
    joints: roads.joints,
    junctions: roads.junctions,
    outlines: pads.outlines.done(),
    pads: pads.writer.vertices.done(),
    padVertices: pads.writer.count,
    parcels: pads.parcels.done(),
    ribbons: roads.writer.vertices.done(),
    ribbonVertices: roads.writer.count,
    roads: roads.roads.done(),
  };
}
