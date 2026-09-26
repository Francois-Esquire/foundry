import type { InternalRewiringScenario } from "../lib/internal-rewiring-types";

import type { AtlasInternals } from "./internals";

export interface RouteEndpoint {
  id: string;
  kind: "file" | "responsibility";
}
export interface ScenarioRoute {
  source: RouteEndpoint;
  target: RouteEndpoint;
}

export function scenarioRoutes(
  data: AtlasInternals,
  scenario: Pick<InternalRewiringScenario, "proposed" | "subject">
) {
  const proposed: ScenarioRoute[] = [];
  const sourceModules = new Set<string>();
  const file = (module: string): RouteEndpoint | undefined =>
    data.fileIds[module]
      ? { id: data.fileIds[module], kind: "file" }
      : undefined;
  let unmapped = 0;
  const add = (sourceModule: string, target: RouteEndpoint | undefined) => {
    sourceModules.add(sourceModule);
    const source = file(sourceModule);
    if (source && target) {
      proposed.push({ source, target });
    } else {
      unmapped++;
    }
  };
  for (const edge of scenario.proposed.redirect ?? []) {
    add(edge.source, file(edge.target));
  }
  const surface = scenario.proposed.surface;
  if (surface) {
    for (const source of surface.consumerModules) {
      add(
        source,
        data.responsibilities.regions.some(
          (region) => region.id === surface.responsibility
        )
          ? { id: surface.responsibility, kind: "responsibility" }
          : undefined
      );
    }
  }
  const collapse = scenario.proposed.collapse;
  if (collapse) {
    for (const provider of collapse.providers) {
      add(collapse.consumer, file(provider));
    }
  }
  const baseline = data.topology.edges
    .filter((edge) => edge.primary && sourceModules.has(edge.source))
    .flatMap((edge) => {
      const source = file(edge.source),
        target = file(edge.target);
      return source && target ? [{ source, target }] : [];
    });
  const unique = (routes: ScenarioRoute[]) =>
    [
      ...new Map(
        routes.map((route) => [
          `${route.source.kind}:${route.source.id}:${route.target.kind}:${route.target.id}`,
          route,
        ])
      ).values(),
    ].sort(
      (a, b) =>
        a.source.id.localeCompare(b.source.id) ||
        a.target.id.localeCompare(b.target.id)
    );
  return { baseline: unique(baseline), proposed: unique(proposed), unmapped };
}
