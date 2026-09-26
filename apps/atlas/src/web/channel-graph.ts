import { roundSeaLane } from "./sea-lane";
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
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
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
  for (let root = 0; root < points.length; root++) {
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
    const starts = portals(from),
      ends = portals(to);
    const pair = [...starts]
      .flatMap(([component, start]) => {
        const end = ends.get(component);
        return end ? [{ end, start }] : [];
      })
      .sort(
        (a, b) =>
          a.start.distance + a.end.distance - b.start.distance - b.end.distance
      )[0];
    if (!pair) {
      return [];
    }
    const previous = new Int32Array(points.length).fill(-1);
    const queue = [pair.start.id];
    previous[pair.start.id] = pair.start.id;
    for (let n = 0; n < queue.length && previous[pair.end.id] === -1; n++) {
      for (const next of edges[queue[n] ?? pair.start.id] ?? []) {
        if (previous[next] !== -1) {
          continue;
        }
        previous[next] = queue[n] ?? pair.start.id;
        queue.push(next);
      }
    }
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
    const step = Math.hypot(
      vertex(1, 0).x - vertex(0, 0).x,
      vertex(1, 0).y - vertex(0, 0).y
    );
    const simplify = (part: TradePoint[]): TradePoint[] => {
      const a = part[0],
        b = part.at(-1);
      if (!(a && b) || part.length < 3) {
        return part;
      }
      let maximum = 0,
        split = 1;
      part.forEach((p, i) => {
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const t = Math.max(
          0,
          Math.min(
            1,
            ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)
          )
        );
        const distance = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
        if (distance > maximum) {
          maximum = distance;
          split = i;
        }
      });
      if (maximum <= step && clear(a, b)) {
        return [a, b];
      }
      return [
        ...simplify(part.slice(0, split + 1)).slice(0, -1),
        ...simplify(part.slice(split)),
      ];
    };
    return roundSeaLane([from, ...simplify(path.slice(1, -1)), to], clear);
  };
}
