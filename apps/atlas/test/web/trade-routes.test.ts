import { describe, expect, it } from "vitest";
import { compositionInsideLand } from "../../src/web/composition-placement";
import {
  createTradeNavigation,
  leadingTrades,
} from "../../src/web/trade-routes";
import type { AtlasData, Territory } from "../../src/web/types";

const island = (id: string, x: number, radius = 20): Territory => ({
  analyzed: true,
  coast: [
    [
      [
        [-radius, -radius],
        [radius, -radius],
        [radius, radius],
        [-radius, radius],
        [-radius, -radius],
      ],
    ],
  ],
  color: "#efcf88",
  files: [
    {
      directory: "src",
      id,
      incoming: 1,
      kind: "source",
      outgoing: 1,
      path: id,
      x: 0,
      y: 0,
    },
  ],
  hills: [],
  id,
  label: id,
  neighborhoods: [],
  radius,
  shallows: [],
  x,
  y: 0,
});
const fixture = (): AtlasData => ({
  coverage: "test",
  fileEdges: [{ source: "consumer", target: "supplier" }],
  generatedAt: "test",
  height: 300,
  routes: [{ from: "consumer", sharedConcepts: 0, to: "supplier", weight: 20 }],
  territories: [
    island("consumer", -120),
    island("supplier", 120),
    island("obstacle", 0, 45),
  ],
  width: 400,
});

describe("coastal trade", () => {
  it("routes around intervening land and keeps exact endpoint membership without moving geography", () => {
    const data = fixture(),
      before = structuredClone(data);
    const navigate = createTradeNavigation(data);
    const routes = navigate();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.consumer.files).toEqual(["consumer"]);
    expect(routes[0]?.supplier.files).toEqual(["supplier"]);
    const points = routes[0]?.points ?? [];
    expect(points.some((p) => Math.abs(p.y) > 45)).toBe(true);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      if (!(a && b)) {
        throw new Error("Missing route segment");
      }
      for (let n = 0; n <= 100; n++) {
        const x = a.x + ((b.x - a.x) * n) / 100,
          y = a.y + ((b.y - a.y) * n) / 100;
        expect(
          data.territories.some((p) =>
            compositionInsideLand(x - p.x, y - p.y, p.coast)
          )
        ).toBe(false);
      }
    }
    expect(navigate()).toEqual(routes);
    expect(
      createTradeNavigation({
        ...data,
        territories: [...data.territories].reverse(),
      })()
    ).toEqual(routes);
    expect(data).toEqual(before);
  });

  it("does not invent a crossing when land separates the water", () => {
    const data = fixture();
    const obstacle = data.territories[2];
    if (!obstacle) {
      throw new Error("Missing obstacle");
    }
    obstacle.coast = [
      [
        [
          [-2, -200],
          [2, -200],
          [2, 200],
          [-2, 200],
          [-2, -200],
        ],
      ],
    ];
    expect(createTradeNavigation(data)()).toEqual([]);
  });

  it("retains a package-level fallback when file endpoints are absent", () => {
    const data = fixture();
    data.fileEdges = [];
    expect(createTradeNavigation(data)()[0]?.supplier.files).toEqual([]);
  });

  it("chooses an exterior harbor instead of an enclosed coastal basin", () => {
    const data = fixture();
    const consumer = data.territories[0];
    if (!consumer) {
      throw new Error("Missing consumer");
    }
    consumer.coast = [
      [
        [
          [-40, -40],
          [40, -40],
          [40, -1],
          [0, -1],
          [0, -20],
          [-20, -20],
          [-20, 20],
          [0, 20],
          [0, 1],
          [40, 1],
          [40, 40],
          [-40, 40],
          [-40, -40],
        ],
      ],
    ];
    consumer.files = consumer.files.map((f) => ({ ...f, x: -25 }));
    const route = createTradeNavigation(data)()[0];
    expect(route).toBeDefined();
    if (!route) {
      throw new Error("Missing exterior route");
    }
    expect(
      Math.abs(route.consumer.water.x - consumer.x) > 40 ||
        Math.abs(route.consumer.water.y) > 40
    ).toBe(true);
  });

  it("selects six leading consumers and six incident trades with canonical tie breaks", () => {
    const data = fixture();
    data.territories = Array.from({ length: 9 }, (_, i) =>
      island(String(i), i * 20)
    );
    data.routes = data.territories
      .slice(1)
      .map((p) => ({ from: p.id, sharedConcepts: 0, to: "0", weight: 10 }));
    expect(leadingTrades(data).map((r) => r.from)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    expect(leadingTrades(data, "0")).toHaveLength(6);
    expect(leadingTrades(data, "8")).toHaveLength(1);
    expect(
      leadingTrades({ ...data, routes: [...data.routes].reverse() })
    ).toEqual(leadingTrades(data));
    expect(
      leadingTrades({
        ...data,
        routes: [{ from: "0", sharedConcepts: 0, to: "0", weight: 5 }],
      })
    ).toEqual([]);
  });
});
