import { directSeaLane, smoothSeaLane } from "./sea-lane";
import type { TradePoint } from "./trade-routes";

export function createChannelGraph(
  owners: Int32Array,
  width: number,
  height: number,
  vertex: (x: number, y: number) => TradePoint,
  clear: (a: TradePoint, b: TradePoint) => boolean
) {
  const points: TradePoint[] = [];
  const edges: number[][] = [];
  const ids = new Map<number, number>();
  const node = (x: number, y: number) => {
    const key = y * (width + 1) + x;
    let id = ids.get(key);
    if (id === undefined) {
      id = points.length;
      ids.set(key, id);
      points.push(vertex(x, y));
      edges.push([]);
    }
    return id;
  };
  const connect = (x: number, y: number, xx: number, yy: number) => {
    if (!clear(vertex(x, y), vertex(xx, yy))) {
      return;
    }
    const a = node(x, y),
      b = node(xx, yy);
    edges[a]?.push(b);
    edges[b]?.push(a);
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (x + 1 < width && owners[i] !== owners[i + 1]) {
        connect(x + 1, y, x + 1, y + 1);
      }
      if (y + 1 < height && owners[i] !== owners[i + width]) {
        connect(x, y + 1, x + 1, y + 1);
      }
    }
  }
  const components = new Int32Array(points.length).fill(-1);
  createChannelGraphRoot(points, components, edges);
  const portals = (p: TradePoint) => {
    const nearest = new Map<number, { id: number; distance: number }>();
    points.forEach((q, id) => {
      const component = components[id] ?? -1;
      const distance = Math.hypot(q.x - p.x, q.y - p.y);
      if (
        distance >=
        (nearest.get(component)?.distance ?? Number.POSITIVE_INFINITY)
      ) {
        return;
      }
      if (clear(p, q)) {
        nearest.set(component, { distance, id });
      }
    });
    return nearest;
  };
  return (from: TradePoint, to: TradePoint): TradePoint[] => {
    const direct = directSeaLane(from, to, clear);
    if (direct) {
      return direct;
    }
    const starts = portals(from),
      ends = portals(to);
    const [pair] = [...starts]
      .flatMap(([component, start]) => {
        const end = ends.get(component);
        return end ? [{ end, start }] : [];
      })
      .sort(
        (a, b) =>
          a.start.distance + a.end.distance - b.start.distance - b.end.distance
      );
    if (!pair) {
      return [];
    }
    const previous = new Int32Array(points.length).fill(-1);
    const queue = [pair.start.id];
    previous[pair.start.id] = pair.start.id;
    createChannelGraphN(queue, previous, pair, edges);
    const path = [to];
    for (let i = pair.end.id; ; i = previous[i] ?? pair.start.id) {
      const p = points[i];
      if (p) {
        path.push(p);
      }
      if (i === pair.start.id) {
        break;
      }
    }
    path.push(from);
    path.reverse();
    return smoothSeaLane(path, clear);
  };
}

function createChannelGraphRoot(
  points: TradePoint[],
  components: Int32Array<ArrayBuffer>,
  edges: number[][]
) {
  for (let root = 0; root < points.length; root += 1) {
    if (components[root] !== -1) {
      continue;
    }
    const queue = [root];
    components[root] = root;
    for (const current of queue) {
      for (const next of edges[current] ?? []) {
        if (components[next] === -1) {
          components[next] = root;
          queue.push(next);
        }
      }
    }
  }
}

function createChannelGraphN(
  queue: number[],
  previous: Int32Array<ArrayBuffer>,
  pair: {
    end: { id: number; distance: number };
    start: { id: number; distance: number };
  },
  edges: number[][]
) {
  for (let n = 0; n < queue.length && previous[pair.end.id] === -1; n += 1) {
    for (const next of edges[queue[n] ?? pair.start.id] ?? []) {
      if (previous[next] !== -1) {
        continue;
      }
      previous[next] = queue[n] ?? pair.start.id;
      queue.push(next);
    }
  }
}
