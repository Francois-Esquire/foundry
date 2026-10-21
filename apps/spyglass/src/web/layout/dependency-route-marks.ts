import type { SpyglassData, Territory } from "../data/types";
import { inkStyle } from "../ladder/ink-table";
import { type InkView, viewSquash } from "../view/chart-view";
import { inkedStroke, type Stroke } from "./marks";

interface RouteLocation {
  territory: Territory;
  x: number;
  y: number;
}

interface DependencyRoute {
  from: RouteLocation;
  source: string;
  target: string;
  to: RouteLocation;
}

export interface DependencyRouteOptions {
  selectedFile: string | null;
  selectedTerritory: string | null;
  view: InkView;
}

/** Counts refer to eligible relationships before the visible route budget is applied. */
export interface DependencyRouteContext {
  available: number;
  budget: number;
  routes: readonly DependencyRoute[];
  scope: "overview" | "viewport" | "territory" | "file";
}

const graphCache = new WeakMap<SpyglassData, readonly DependencyRoute[]>();

function compareIds(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/** Analysis order never decides which relationships survive the display budget. */
function rankedRoutes(data: SpyglassData): readonly DependencyRoute[] {
  const cached = graphCache.get(data);
  if (cached) {
    return cached;
  }
  const locations = new Map<string, RouteLocation>();
  for (const territory of data.territories) {
    for (const file of territory.files) {
      locations.set(file.id, {
        territory,
        x: territory.x + file.x,
        y: territory.y + file.y,
      });
    }
  }
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const seen = new Set<string>();
  const routes: DependencyRoute[] = [];
  for (const { source, target } of data.fileEdges) {
    const from = locations.get(source);
    const to = locations.get(target);
    const key = JSON.stringify([source, target]);
    if (!(from && to) || source === target || seen.has(key)) {
      continue;
    }
    seen.add(key);
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
    outgoing.set(source, (outgoing.get(source) ?? 0) + 1);
    routes.push({ from, source, target, to });
  }
  const importance = (route: DependencyRoute) =>
    (incoming.get(route.target) ?? 0) + (outgoing.get(route.source) ?? 0);
  routes.sort(
    (a, b) =>
      importance(b) - importance(a) ||
      compareIds(a.source, b.source) ||
      compareIds(a.target, b.target)
  );
  graphCache.set(data, routes);
  return routes;
}

function inView(location: RouteLocation, view: InkView): boolean {
  return (
    Math.abs(location.x - view.x) <= view.width / 2 &&
    Math.abs(location.y - view.y) <= view.height / 2
  );
}

/**
 * World views keep package trades. Closer views reveal local relationships in
 * the viewed or focused territory. A visible selected file owns the budget,
 * including relationships across territory boundaries; unrelated edges recede.
 */
export function dependencyRouteContext(
  data: SpyglassData,
  { selectedFile, selectedTerritory, view }: DependencyRouteOptions
): DependencyRouteContext {
  if (view.pixelsPerUnit < 1.5) {
    return { available: 0, budget: 0, routes: [], scope: "overview" };
  }
  const budget = view.pixelsPerUnit < 5 ? 12 : 24;
  const routes = rankedRoutes(data).filter((route) => {
    if (selectedFile) {
      return (
        (route.source === selectedFile && inView(route.from, view)) ||
        (route.target === selectedFile && inView(route.to, view))
      );
    }
    return (
      route.from.territory.id === route.to.territory.id &&
      (!selectedTerritory || route.from.territory.id === selectedTerritory) &&
      (inView(route.from, view) || inView(route.to, view))
    );
  });
  let scope: DependencyRouteContext["scope"] = "viewport";
  if (selectedFile) {
    scope = "file";
  } else if (selectedTerritory) {
    scope = "territory";
  }
  return {
    available: routes.length,
    budget,
    routes: routes.slice(0, budget),
    scope,
  };
}

/** A screen-sized chevron near the imported endpoint points consumer → dependency. */
function arrowPoints(route: DependencyRoute, view: InkView): number[] {
  const { from, to } = route;
  const pixels = view.pixelsPerUnit;
  const squash = viewSquash(view);
  const dx = (to.x - from.x) * pixels;
  const dy = (to.y - from.y) * pixels * squash;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-6) {
    return [];
  }
  const ux = dx / distance;
  const uy = dy / distance;
  const head = Math.min(6, distance * 0.2);
  const inset = Math.min(10, distance * 0.2);
  const tipX = to.x - (ux * inset) / pixels;
  const tipY = to.y - (uy * inset) / pixels / squash;
  const baseX = tipX - (ux * head) / pixels;
  const baseY = tipY - (uy * head) / pixels / squash;
  return [
    baseX - (uy * head * 0.5) / pixels,
    baseY + (ux * head * 0.5) / pixels / squash,
    tipX,
    tipY,
    baseX + (uy * head * 0.5) / pixels,
    baseY - (ux * head * 0.5) / pixels / squash,
  ];
}

/** Canonical file endpoints and arrowheads are draped by the shared chart geometry. */
export function dependencyRouteMarks(
  data: SpyglassData,
  options: DependencyRouteOptions
): Stroke[] {
  const context = dependencyRouteContext(data, options);
  return context.routes.flatMap((route) => {
    let style = inkStyle("traced-import");
    if (options.selectedFile) {
      style = inkStyle(
        route.source === options.selectedFile
          ? "selection-imports"
          : "selection-importers"
      );
    }
    const { from, to } = route;
    const shaft = inkedStroke(style, [from.x, from.y, to.x, to.y], {
      alpha: 0.73,
      cap: "round",
      on: "chart",
    });
    const arrow = arrowPoints(route, options.view);
    return arrow.length
      ? [
          shaft,
          inkedStroke({ ...style, dash: [] }, arrow, {
            alpha: 0.9,
            cap: "round",
            on: "chart",
          }),
        ]
      : [shaft];
  });
}
