import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
} from "three";
import {
  abs,
  attribute,
  Discard,
  Fn,
  float,
  min,
  mod,
  smoothstep,
  uniform,
  uv,
} from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { compositionInsideLand } from "../composition-placement";
import { laneWidth } from "../data/bindings";
import type { SpyglassData } from "../data/types";
import { inkStyle } from "../ladder/ink-ladder";
import { roundSeaLane } from "../sea-lane";
import type { TradePoint, TradeRoute } from "../trade-routes";

/** Sea trade routes: one dashed lane per route, between its two harbors. */
export function createTradeLayer(data: SpyglassData) {
  const group = new Group();
  const style = inkStyle("trade");
  const [dash = 8, gap = 6] = style.dash;
  const ink = uniform(new Color(style.hue));
  const laneMaterial = new MeshBasicNodeMaterial({
    depthWrite: false,
    side: DoubleSide,
    transparent: true,
  });
  const laneUv = uv();
  const laneLength = attribute<"float">("routeLength", "float");
  // Dashed sea lanes in map units, measured from both ends so dashes stay
  // symmetric no matter the route length.
  laneMaterial.colorNode = Fn(() => {
    const along = min(laneUv.x, laneLength.sub(laneUv.x));
    Discard(mod(along, dash + gap).greaterThan(dash));
    return ink;
  })();
  laneMaterial.opacityNode = float(1)
    .sub(smoothstep(0.7, 1, abs(laneUv.y)))
    .mul(0.65);
  let paths: BufferGeometry[] = [];
  let signature = "";
  const clearWater = (a: TradePoint, b: TradePoint) => {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
    for (let n = 0; n <= steps; n += 1) {
      const t = n / Math.max(1, steps),
        x = a.x + (b.x - a.x) * t,
        y = a.y + (b.y - a.y) * t;
      if (
        data.territories.some((p) =>
          compositionInsideLand(x - p.x, y - p.y, p.coast)
        )
      ) {
        return false;
      }
    }
    return true;
  };
  return {
    dispose: () => {
      for (const geometry of paths) {
        geometry.dispose();
      }
      laneMaterial.dispose();
      group.clear();
    },
    group,
    setRoutes: (routes: TradeRoute[]) => {
      const next = JSON.stringify(
        routes.map((r) => [
          r.dependency.from,
          r.dependency.to,
          r.dependency.weight,
        ])
      );
      if (next === signature) {
        return;
      }
      signature = next;
      group.clear();
      for (const geometry of paths) {
        geometry.dispose();
      }
      paths = [];
      const maximum = Math.max(1, ...routes.map((r) => r.dependency.weight));
      for (const route of routes) {
        const points = roundSeaLane(
          [route.consumer.coast, ...route.points, route.supplier.coast],
          clearWater
        );
        const positions: number[] = [],
          laneUvs: number[] = [],
          indices: number[] = [];
        let length = 0;
        points.forEach((p, i) => {
          const before = points[i - 1] ?? p,
            after = points[i + 1] ?? p;
          length += Math.hypot(p.x - before.x, p.y - before.y);
          const dx = after.x - before.x,
            dy = after.y - before.y,
            magnitude = Math.hypot(dx, dy) || 1;
          const width = laneWidth(route.dependency.weight, maximum);
          for (const side of [-1, 1]) {
            positions.push(
              p.x - (dy / magnitude) * width * side,
              -p.y - (dx / magnitude) * width * side,
              0.08
            );
            laneUvs.push(length, side);
          }
          if (i) {
            const j = i * 2;
            indices.push(j - 2, j - 1, j, j - 1, j + 1, j);
          }
        });
        const geometry = new BufferGeometry();
        geometry.setAttribute(
          "position",
          new Float32BufferAttribute(positions, 3)
        );
        geometry.setAttribute("uv", new Float32BufferAttribute(laneUvs, 2));
        geometry.setAttribute(
          "routeLength",
          new Float32BufferAttribute(
            new Float32Array(points.length * 2).fill(length),
            1
          )
        );
        geometry.setIndex(indices);
        paths.push(geometry);
        group.add(new Mesh(geometry, laneMaterial));
      }
    },
  };
}
