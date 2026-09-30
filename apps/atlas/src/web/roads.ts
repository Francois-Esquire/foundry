import { insidePolygons } from "./atmosphere";
import type { Continent } from "./continent";
import { continentCell, continentHeight } from "./continent";
import { relaxRoad } from "./relax-road";
import { terrainHeight } from "./scene/terrain";
import type { TradePoint, TradeRoute } from "./trade-routes";
import type { AtlasData, AtlasRoute } from "./types";

export function createRoadNetwork(data: AtlasData, continents: Continent[]) {
  const routes: TradeRoute[] = [];
  const segments: { a: TradePoint; b: TradePoint; weight: number }[] = [];
  const elevation = (p: TradePoint) => {
    let z = 0.16;
    for (const c of continents) {
      if (c.field.filled[continentCell(c, p.x, p.y)]) {
        z = Math.max(z, continentHeight(c, p.x, p.y));
      }
    }
    for (const t of data.territories) {
      if (insidePolygons({ x: p.x - t.x, y: p.y - t.y }, t.coast)) {
        z = Math.max(z, terrainHeight(t, p.x - t.x, p.y - t.y));
      }
    }
    return z;
  };
  for (const c of continents) {
    const { field } = c;
    const stride = 3,
      step = field.step * stride;
    const width = Math.ceil(field.width / stride),
      height = Math.ceil(field.height / stride);
    const point = (i: number) =>
      field.point(
        Math.floor(i / width) * stride * field.width + (i % width) * stride
      );
    const land = (p: TradePoint) => {
      const i = continentCell(c, p.x, p.y);
      return (
        Boolean(field.filled[i]) && (field.inland[i] ?? 0) * field.step >= 10
      );
    };
    const clear = (a: TradePoint, b: TradePoint) => {
      const n = Math.ceil(Math.hypot(a.x - b.x, a.y - b.y) / 2);
      for (let j = 0; j <= n; j += 1) {
        const t = j / Math.max(1, n);
        if (!land({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) {
          return false;
        }
      }
      return true;
    };
    const open = Array.from({ length: width * height }, (_, i) =>
      land(point(i))
    );
    const heights = open.map((value, i) => (value ? elevation(point(i)) : 0));
    const anchors = new Map<string, number>();
    for (const p of c.members) {
      let best = -1,
        distance = Number.POSITIVE_INFINITY;
      open.forEach((value, i) => {
        if (!value) {
          return;
        }
        const q = point(i),
          d = Math.hypot(q.x - p.x, q.y - p.y);
        if (
          d < distance &&
          insidePolygons({ x: q.x - p.x, y: q.y - p.y }, p.coast)
        ) {
          best = i;
          distance = d;
        }
      });
      if (best >= 0) {
        anchors.set(p.id, best);
      }
    }
    const used = new Map<string, { a: number; b: number; weight: number }>();
    const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
    const dependencies = data.routes
      .filter(
        (r) =>
          r.weight > 0 &&
          r.from !== r.to &&
          anchors.has(r.from) &&
          anchors.has(r.to)
      )
      .sort(
        (a, b) =>
          b.weight - a.weight ||
          a.from.localeCompare(b.from) ||
          a.to.localeCompare(b.to)
      );
    createRoadNetworkDependency(
      dependencies,
      anchors,
      open,
      width,
      height,
      used,
      key,
      step,
      heights,
      clear,
      point,
      data,
      routes
    );
    for (const edge of used.values()) {
      segments.push({
        a: point(edge.a),
        b: point(edge.b),
        weight: edge.weight,
      });
    }
  }
  const junctions = new Map<string, number[]>();
  const id = (p: TradePoint) => `${p.x}:${p.y}`;
  const terminals = new Set(
    routes.flatMap((r) => [id(r.consumer.coast), id(r.supplier.coast)])
  );
  const heightCache = new Map<string, number>();
  const sampledHeight = (p: TradePoint) => {
    const q = { x: Math.round(p.x / 2) * 2, y: Math.round(p.y / 2) * 2 },
      key = id(q);
    let value = heightCache.get(key);
    if (value === undefined) {
      value = elevation(q);
      heightCache.set(key, value);
    }
    return value;
  };
  segments.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      junctions.set(id(p), [...(junctions.get(id(p)) ?? []), i]);
    }
  });
  const visited = new Set<number>();
  const paths: { points: TradePoint[]; weight: number }[] = [];
  const clear = (a: TradePoint, b: TradePoint) => {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2);
    return continents.some((c) => {
      for (let n = 0; n <= steps; n += 1) {
        const t = n / Math.max(1, steps),
          i = continentCell(c, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        if (
          !c.field.filled[i] ||
          (c.field.inland[i] ?? 0) * c.field.step < 10
        ) {
          return false;
        }
      }
      return true;
    });
  };
  const walk = (start: TradePoint, initialEdge: number) => {
    let edge = initialEdge;
    const points = [start];
    let weight = 0,
      p = start;
    while (!visited.has(edge)) {
      visited.add(edge);
      const segment = segments[edge];
      if (!segment) {
        break;
      }
      weight = Math.max(weight, segment.weight);
      p = id(p) === id(segment.a) ? segment.b : segment.a;
      points.push(p);
      const next = junctions.get(id(p)) ?? [];
      if (next.length !== 2 || terminals.has(id(p))) {
        break;
      }
      edge = next.find((i) => !visited.has(i)) ?? edge;
    }
    paths.push({ points: relaxRoad(points, clear, sampledHeight), weight });
  };
  segments.forEach((s, i) => {
    if (
      !visited.has(i) &&
      (junctions.get(id(s.a))?.length !== 2 || terminals.has(id(s.a)))
    ) {
      walk(s.a, i);
    }
    if (
      !visited.has(i) &&
      (junctions.get(id(s.b))?.length !== 2 || terminals.has(id(s.b)))
    ) {
      walk(s.b, i);
    }
  });
  segments.forEach((s, i) => {
    if (!visited.has(i)) {
      walk(s.a, i);
    }
  });
  return { elevation, paths, routes, segments };
}

function createRoadNetworkDependency(
  dependencies: AtlasRoute[],
  anchors: Map<string, number>,
  open: boolean[],
  width: number,
  height: number,
  used: Map<string, { a: number; b: number; weight: number }>,
  key: (a: number, b: number) => string,
  step: number,
  heights: number[],
  clear: (a: TradePoint, b: TradePoint) => boolean,
  point: (i: number) => { x: number; y: number },
  data: AtlasData,
  routes: TradeRoute[]
) {
  for (const dependency of dependencies) {
    const start = anchors.get(dependency.from),
      end = anchors.get(dependency.to);
    if (start === undefined || end === undefined) {
      continue;
    }
    const distances = new Float64Array(open.length).fill(
      Number.POSITIVE_INFINITY
    );
    const previous = new Int32Array(open.length).fill(-1);
    const heap: { i: number; cost: number }[] = [];
    const push = (i: number, cost: number) => {
      let n = heap.length;
      heap.push({ cost, i });
      while (n > 0) {
        const parent = Math.floor((n - 1) / 2),
          entry = heap[parent];
        if (!entry || entry.cost <= cost) {
          break;
        }
        heap[n] = entry;
        n = parent;
      }
      heap[n] = { cost, i };
    };
    const pop = () => {
      const [first] = heap,
        last = heap.pop();
      popEntries(heap, last);
      return first;
    };
    distances[start] = 0;
    push(start, 0);
    createRoadNetworkDependencyEntries(
      heap,
      pop,
      distances,
      end,
      width,
      height,
      open,
      used,
      key,
      step,
      heights,
      clear,
      point,
      previous,
      push
    );
    if (!Number.isFinite(distances[end])) {
      continue;
    }
    const cells = [end];
    for (let i = end; i !== start; ) {
      i = previous[i] ?? start;
      cells.push(i);
    }
    cells.reverse();
    for (let i = 1; i < cells.length; i += 1) {
      const a = cells[i - 1] ?? start,
        b = cells[i] ?? end,
        id = key(a, b);
      const edge = used.get(id) ?? { a, b, weight: 0 };
      edge.weight += dependency.weight;
      used.set(id, edge);
    }
    const source = data.territories.find((p) => p.id === dependency.from);
    const target = data.territories.find((p) => p.id === dependency.to);
    if (!(source && target)) {
      continue;
    }
    const sources = new Set(source.files.map((f) => f.id)),
      targets = new Set(target.files.map((f) => f.id));
    const evidence = data.fileEdges.filter(
      (e) => sources.has(e.source) && targets.has(e.target)
    );
    routes.push({
      consumer: {
        coast: point(start),
        files: [...new Set(evidence.map((e) => e.source))].sort(),
        territory: source.id,
        water: point(start),
      },
      dependency,
      points: cells.map(point),
      supplier: {
        coast: point(end),
        files: [...new Set(evidence.map((e) => e.target))].sort(),
        territory: target.id,
        water: point(end),
      },
    });
  }
}

function createRoadNetworkDependencyEntries(
  heap: { i: number; cost: number }[],
  pop: () => { i: number; cost: number } | undefined,
  distances: Float64Array<ArrayBuffer>,
  end: number,
  width: number,
  height: number,
  open: boolean[],
  used: Map<string, { a: number; b: number; weight: number }>,
  key: (a: number, b: number) => string,
  step: number,
  heights: number[],
  clear: (a: TradePoint, b: TradePoint) => boolean,
  point: (i: number) => { x: number; y: number },
  previous: Int32Array<ArrayBuffer>,
  push: (i: number, cost: number) => void
) {
  while (heap.length) {
    const current = pop();
    if (!current) {
      break;
    }
    if (current.cost !== distances[current.i]) {
      continue;
    }
    if (current.i === end) {
      break;
    }
    const x = current.i % width,
      y = Math.floor(current.i / width);
    createRoadNetworkDependencyEntriesDy(
      x,
      width,
      y,
      height,
      open,
      used,
      key,
      current,
      step,
      heights,
      distances,
      clear,
      point,
      previous,
      push
    );
  }
}

function createRoadNetworkDependencyEntriesDy(
  x: number,
  width: number,
  y: number,
  height: number,
  open: boolean[],
  used: Map<string, { a: number; b: number; weight: number }>,
  key: (a: number, b: number) => string,
  current: { i: number; cost: number },
  step: number,
  heights: number[],
  distances: Float64Array<ArrayBuffer>,
  clear: (a: TradePoint, b: TradePoint) => boolean,
  point: (i: number) => { x: number; y: number },
  previous: Int32Array<ArrayBuffer>,
  push: (i: number, cost: number) => void
) {
  for (let dy = -1; dy <= 1; dy += 1) {
    createRoadNetworkDependencyEntriesDyDx(
      dy,
      x,
      width,
      y,
      height,
      open,
      used,
      key,
      current,
      step,
      heights,
      distances,
      clear,
      point,
      previous,
      push
    );
  }
}

function createRoadNetworkDependencyEntriesDyDx(
  dy: number,
  x: number,
  width: number,
  y: number,
  height: number,
  open: boolean[],
  used: Map<string, { a: number; b: number; weight: number }>,
  key: (a: number, b: number) => string,
  current: { i: number; cost: number },
  step: number,
  heights: number[],
  distances: Float64Array<ArrayBuffer>,
  clear: (a: TradePoint, b: TradePoint) => boolean,
  point: (i: number) => { x: number; y: number },
  previous: Int32Array<ArrayBuffer>,
  push: (i: number, cost: number) => void
) {
  for (let dx = -1; dx <= 1; dx += 1) {
    if (
      !(dx || dy) ||
      x + dx < 0 ||
      x + dx >= width ||
      y + dy < 0 ||
      y + dy >= height
    ) {
      continue;
    }
    const next = (y + dy) * width + x + dx;
    if (!open[next]) {
      continue;
    }
    const shared = used.has(key(current.i, next));
    const cost =
      current.cost +
      step * Math.hypot(dx, dy) * (shared ? 0.55 : 1) +
      Math.abs((heights[next] ?? 0) - (heights[current.i] ?? 0)) * 5;
    if (
      cost >= (distances[next] ?? Number.POSITIVE_INFINITY) ||
      !clear(point(current.i), point(next))
    ) {
      continue;
    }
    distances[next] = cost;
    previous[next] = current.i;
    push(next, cost);
  }
}

function popEntries(
  heap: { i: number; cost: number }[],
  last: { i: number; cost: number } | undefined
) {
  if (heap.length && last) {
    let n = 0;
    while (n * 2 + 1 < heap.length) {
      let child = n * 2 + 1;
      if (
        (heap[child + 1]?.cost ?? Number.POSITIVE_INFINITY) <
        (heap[child]?.cost ?? Number.POSITIVE_INFINITY)
      ) {
        child += 1;
      }
      const next = heap[child];
      if (!next || next.cost >= last.cost) {
        break;
      }
      heap[n] = next;
      n = child;
    }
    heap[n] = last;
  }
}
