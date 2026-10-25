import type { SpyglassData } from "../data/types";
import type { Continent } from "./continent";
import { createRoadNetwork } from "./roads";
import {
  createTradeNavigation,
  leadingTrades,
  type TradeRoute,
} from "./trade-routes";

/**
 * The chart's trades: roads over connecting land, sea lanes between islands
 * apart, and the leading trades of an island (or of the whole chart) along
 * whichever of the two carries each.
 */
export function createTradeChart(
  data: SpyglassData,
  continents: readonly Continent[],
  roadsDrawn: boolean
) {
  const roads = createRoadNetwork(data, roadsDrawn ? [...continents] : []);
  const inland = (from: string, to: string) =>
    continents.some(
      (c) =>
        c.members.some((p) => p.id === from) &&
        c.members.some((p) => p.id === to)
    );
  const navigateSea = createTradeNavigation({
    ...data,
    routes: data.routes.filter((r) => !inland(r.from, r.to)),
  });
  return {
    roads,
    /** The trades that cross water, which the sea lanes draw. */
    seaTrades: (trades: readonly TradeRoute[]): TradeRoute[] =>
      trades.filter((r) => !inland(r.dependency.from, r.dependency.to)),
    /** The leading trades of an island, or of the chart, each along its road or sea lane. */
    trades: (selected?: string | null): TradeRoute[] => {
      const available = [...roads.routes, ...navigateSea(selected)];
      return leadingTrades(data, selected).flatMap(
        (r) =>
          available.find(
            (a) => a.dependency.from === r.from && a.dependency.to === r.to
          ) ?? []
      );
    },
  };
}
