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
  readonly islandOrder: ReadonlyMap<string, number>;
  readonly islands: ReadonlyMap<string, Island>;
  readonly routesFrom: ReadonlyMap<string, readonly Route[]>;
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
