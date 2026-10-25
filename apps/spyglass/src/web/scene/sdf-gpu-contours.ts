import {
  ceil,
  Fn,
  float,
  If,
  instanceIndex,
  int,
  max,
  min,
  select,
  vec2,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { ColumnStorages } from "./sdf-gpu-columns";
import {
  columnIndex,
  columnOf,
  countLoop,
  type IslandUniforms,
} from "./sdf-gpu-island";

/**
 * The SDF trial's footprint distances on the GPU: each contour the CPU
 * traces (`contourSegments`, marching squares with saddles split by the
 * cell's mean) traced again in every cell within `reach` of a column, and
 * measured exactly to its segments; held at `reach`, negative inside, as
 * `segmentDistance` gives. The bench's is the coast's own, past the
 * lagoon's shore where the island holds one.
 */

/** Map units past which a footprint's distance is held (`SdfIslandSettings.reach`). */
const reach = 8;

/** A footprint distance for a slab an island lacks: far outside it. */
const absentDistance = 1e4;

/** Squared distance from (px, py) to the segment (ax, ay)–(bx, by). */
const segmentSquared = Fn(([ax, ay, bx, by, px, py]: Node<"float">[]) => {
  const dx = (bx as Node<"float">).sub(ax as Node<"float">);
  const dy = (by as Node<"float">).sub(ay as Node<"float">);
  const qx = (px as Node<"float">).sub(ax as Node<"float">);
  const qy = (py as Node<"float">).sub(ay as Node<"float">);
  const t = qx
    .mul(dx)
    .add(qy.mul(dy))
    .div(max(dx.mul(dx).add(dy.mul(dy)), 1e-12))
    .clamp(0, 1);
  const ex = qx.sub(t.mul(dx));
  const ey = qy.sub(t.mul(dy));
  return ex.mul(ex).add(ey.mul(ey));
}).setLayout({
  inputs: ["ax", "ay", "bx", "by", "px", "py"].map((name) => ({
    name,
    type: "float",
  })),
  name: "sdfSegmentSquared",
  type: "float",
});

/**
 * Squared distance, lattice units, from (px, py) (relative to the cell's
 * top-left corner) to one cell's contour, corners `a` top left, `b`, `c`,
 * `d` clockwise, each less the level; far where the contour misses it.
 */
const cellSquared = Fn(([a, b, c, d, px, py]: Node<"float">[]) => {
  const ca = a as Node<"float">;
  const cb = b as Node<"float">;
  const cc = c as Node<"float">;
  const cd = d as Node<"float">;
  const x = px as Node<"float">;
  const y = py as Node<"float">;
  const share = (p: Node<"float">, q: Node<"float">) =>
    p.div(select(p.sub(q).abs().greaterThan(1e-12), p.sub(q), float(1e-12)));
  const differ = (p: Node<"float">, q: Node<"float">) =>
    p.greaterThanEqual(0).xor(q.greaterThanEqual(0));
  // The crossing on each side: top, right, bottom, left.
  const crossed = [
    differ(ca, cb),
    differ(cb, cc),
    differ(cd, cc),
    differ(ca, cd),
  ];
  const points = [
    vec2(share(ca, cb), 0),
    vec2(1, share(cb, cc)),
    vec2(share(cd, cc), 1),
    vec2(0, share(ca, cd)),
  ].map((point) => point.toVar());
  const count = crossed
    .map((flag) => select(flag, float(1), float(0)))
    .reduce((sum, value) => sum.add(value));
  const [p0, p1, p2, p3] = points as unknown as [
    Node<"vec2">,
    Node<"vec2">,
    Node<"vec2">,
    Node<"vec2">,
  ];
  const [top, right, bottom, left] = crossed as [
    Node<"bool">,
    Node<"bool">,
    Node<"bool">,
    Node<"bool">,
  ];
  const to = (from: Node<"vec2">, end: Node<"vec2">) =>
    segmentSquared(from.x, from.y, end.x, end.y, x, y);
  // Two sides crossed: one segment, between the first and the last.
  const first = select(top, p0, select(right, p1, p2));
  const last = select(left, p3, select(bottom, p2, p1));
  const single = to(first, last);
  // A saddle: a and c agree, and the cell's mean joins them or splits them.
  const joined = ca
    .add(cb)
    .add(cc)
    .add(cd)
    .greaterThanEqual(0)
    .xor(ca.greaterThanEqual(0))
    .not();
  const saddle = select(
    joined,
    min(to(p0, p1), to(p2, p3)),
    min(to(p3, p0), to(p1, p2))
  );
  return select(
    count.lessThan(1),
    float(1e12),
    select(count.greaterThan(3), saddle, single)
  );
}).setLayout({
  inputs: ["a", "b", "c", "d", "px", "py"].map((name) => ({
    name,
    type: "float",
  })),
  name: "sdfCellSquared",
  type: "float",
});

/** Pass 2: each column's four footprint distances. */
export function footprintsPass(options: {
  storages: ColumnStorages;
  uniforms: IslandUniforms;
}) {
  const { storages, uniforms } = options;
  return Fn(() => {
    const index = instanceIndex.toVar();
    const { column, row } = columnOf(index, uniforms.columns);
    const pc = float(column).toVar();
    const pr = float(row).toVar();
    const band = ceil(float(reach).div(uniforms.spacing)).toVar();
    const best = vec4(1e12).toVar();
    const rowFrom = int(max(pr.sub(band).sub(1), 0));
    const rowTo = int(min(pr.add(band).add(1), uniforms.rows.sub(1)));
    const columnFrom = int(max(pc.sub(band).sub(1), 0));
    const columnTo = int(min(pc.add(band).add(1), uniforms.columns.sub(1)));
    countLoop("cellRow", rowFrom, rowTo, (cellRow) => {
      countLoop("cellColumn", columnFrom, columnTo, (cellColumn) => {
        const cr = float(cellRow);
        const cc = float(cellColumn);
        const at = (dc: number, dr: number) =>
          storages.contours
            .element(columnIndex(cc.add(dc), cr.add(dr), uniforms))
            .toVar();
        const a = at(0, 0);
        const b = at(1, 0);
        const c = at(1, 1);
        const d = at(0, 1);
        const low = min(min(a, b), min(c, d));
        const high = max(max(a, b), max(c, d));
        const px = pc.sub(cc).toVar();
        const py = pr.sub(cr).toVar();
        for (const channel of ["x", "y", "z", "w"] as const) {
          If(
            low[channel].lessThan(0).and(high[channel].greaterThanEqual(0)),
            () => {
              best[channel].assign(
                min(
                  best[channel],
                  cellSquared(
                    a[channel],
                    b[channel],
                    c[channel],
                    d[channel],
                    px,
                    py
                  )
                )
              );
            }
          );
        }
      });
    });
    const own = storages.contours.element(index).toVar();
    const raw = storages.raw.element(index).toVar();
    const measured = (channel: "x" | "y" | "z" | "w") => {
      const distance = min(best[channel].sqrt().mul(uniforms.spacing), reach);
      return select(
        own[channel].greaterThanEqual(0),
        distance.negate(),
        distance
      );
    };
    const coast = raw.z;
    const bench = select(
      uniforms.hasLagoon.greaterThan(0.5),
      max(coast, measured("x").negate()),
      coast
    );
    const escarpment = (slab: number, channel: "y" | "z" | "w") =>
      select(
        (uniforms.profile[slab * 5 + 2] as Node<"float">).lessThan(-1e4),
        float(absentDistance),
        measured(channel)
      );
    storages.distances
      .element(index)
      .assign(
        vec4(bench, escarpment(1, "y"), escarpment(2, "z"), escarpment(3, "w"))
      );
  });
}
