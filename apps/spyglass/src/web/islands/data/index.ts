/**
 * Lookups over a chart, built once: the chart keeps references by id, and
 * this resolves them into `Map`s.
 */
import type {
  Chart,
  Foundation,
  Group,
  Island,
  Route,
  Supplier,
} from "./chart";

export interface ChartIndex {
  readonly foundations: ReadonlyMap<string, Foundation>;
  readonly groups: ReadonlyMap<string, Group>;
  /** Each island's position in `chart.islands`: its index for maps and palettes. */
  readonly islandOrder: ReadonlyMap<string, number>;
  readonly islands: ReadonlyMap<string, Island>;
  /** Routes leaving each island (it depends on their `to`); every island has a list. */
  readonly routesFrom: ReadonlyMap<string, readonly Route[]>;
  /** Routes arriving at each island (their `from` depends on it); every island has a list. */
  readonly routesTo: ReadonlyMap<string, readonly Route[]>;
  readonly suppliers: ReadonlyMap<string, Supplier>;
}

const byId = <T extends { readonly id: string }>(
  items: readonly T[]
): ReadonlyMap<string, T> => new Map(items.map((item) => [item.id, item]));

export function indexChart(chart: Chart): ChartIndex {
  const routesFrom = new Map<string, Route[]>();
  const routesTo = new Map<string, Route[]>();
  for (const { id } of chart.islands) {
    routesFrom.set(id, []);
    routesTo.set(id, []);
  }
  for (const route of chart.routes) {
    routesFrom.get(route.from)?.push(route);
    routesTo.get(route.to)?.push(route);
  }
  return {
    foundations: byId(chart.foundations),
    groups: byId(chart.groups),
    islandOrder: new Map(chart.islands.map(({ id }, index) => [id, index])),
    islands: byId(chart.islands),
    routesFrom,
    routesTo,
    suppliers: byId(chart.suppliers),
  };
}
