import type { Crossing } from "../../lib/collection-types";
import type { SpyglassData } from "../data/types";

/**
 * One pair of packages a crossing joins, from the package that declares the
 * dependency to the package it names: every declared dependency between the
 * two, of any kind and range, as the collection manifest lists them.
 */
export interface CrossingPair {
  /** The declarations, in the manifest's order (by kind, then range). */
  declared: readonly Crossing[];
  from: string;
  to: string;
}

/**
 * The collection manifest's crossings, merged by `from` and `to`: the map
 * draws one line per pair of packages, and Place lists each pair once. In
 * the manifest's order, which sorts by `from`, then `to`. None for a single
 * workspace.
 */
export function crossingPairs(
  data: Pick<SpyglassData, "crossings">
): CrossingPair[] {
  const pairs = new Map<
    string,
    { declared: Crossing[]; from: string; to: string }
  >();
  for (const crossing of data.crossings ?? []) {
    const key = JSON.stringify([crossing.from, crossing.to]);
    const pair = pairs.get(key) ?? {
      declared: [],
      from: crossing.from,
      to: crossing.to,
    };
    pair.declared.push(crossing);
    pairs.set(key, pair);
  }
  return [...pairs.values()];
}

/** The pairs an island takes part in: those it declares, and those that name it. */
export function crossingsOf(
  data: Pick<SpyglassData, "crossings">,
  island: string
): { incoming: CrossingPair[]; outgoing: CrossingPair[] } {
  const pairs = crossingPairs(data);
  return {
    incoming: pairs.filter((pair) => pair.to === island),
    outgoing: pairs.filter((pair) => pair.from === island),
  };
}
