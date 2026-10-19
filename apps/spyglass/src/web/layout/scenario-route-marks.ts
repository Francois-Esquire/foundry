import type { SpyglassFile, Territory } from "../data/types";
import { inkAlpha } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import type { Mark } from "./marks";
import { glyphOn, inkedStroke, runPoints } from "./marks";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import type { RouteEndpoint } from "./scenario-routes";

/** A route's ends, in CSS pixels: the arrowhead's arm on a file, and the ring's radius on a responsibility. */
const routeEnd = { arrow: 5, ring: 6 } as const;
/** How many routes of each kind are drawn. */
const routeBudget = 64;
/** The arrowhead's half angle, in radians. */
const arrowSpread = 0.5;

type ScenarioRoutes = NonNullable<ResponsibilityOverlay["routes"]>;

/** Where a route ends: a file, or the centroid of a responsibility's files. */
function endpointOf(
  endpoint: RouteEndpoint,
  files: Map<string, SpyglassFile>,
  routes: ScenarioRoutes
): { x: number; y: number } | undefined {
  if (endpoint.kind === "file") {
    return files.get(endpoint.id);
  }
  const members =
    routes.scopes
      .find((scope) => scope.id === endpoint.id)
      ?.files.flatMap((id) => files.get(id) ?? []) ?? [];
  return members.length
    ? {
        x: members.reduce((sum, file) => sum + file.x, 0) / members.length,
        y: members.reduce((sum, file) => sum + file.y, 0) / members.length,
      }
    : undefined;
}

/**
 * A scenario's routes: the current ones faint and the proposed ones coming
 * in with the scenario's progress, each a dashed line ending in a ring on
 * a responsibility or an arrowhead on a file. The ring is a glyph; the
 * arrowhead is laid in world units at the zoom.
 */
export function routeMarks(
  overlay: ResponsibilityOverlay,
  pixels: number,
  territory: Territory,
  files: Map<string, SpyglassFile>
): Mark[] {
  const { routes } = overlay;
  if (!routes) {
    return [];
  }
  const marks: Mark[] = [];
  const arm = routeEnd.arrow / pixels;
  for (const [links, style, alpha] of [
    [routes.baseline, inkStyle("scenario-baseline"), inkAlpha.scenarioBaseline],
    [routes.proposed, inkStyle("scenario-proposed"), routes.progress],
  ] as const) {
    const line = (points: number[]) =>
      inkedStroke(style, runPoints(points, territory.x, territory.y), {
        alpha,
        cap: "butt",
        on: territory,
      });
    for (const route of links.slice(0, routeBudget)) {
      const source = endpointOf(route.source, files, routes);
      const target = endpointOf(route.target, files, routes);
      if (!(source && target)) {
        continue;
      }
      marks.push(line([source.x, source.y, target.x, target.y]));
      if (route.target.kind === "responsibility") {
        marks.push(
          glyphOn(territory, target, {
            alpha,
            colour: style.hue,
            shape: "hoop",
            size: 2 * routeEnd.ring,
            weight: style.weight,
          })
        );
      } else {
        const angle = Math.atan2(target.y - source.y, target.x - source.x);
        marks.push(
          line([
            target.x - Math.cos(angle - arrowSpread) * arm,
            target.y - Math.sin(angle - arrowSpread) * arm,
            target.x,
            target.y,
            target.x - Math.cos(angle + arrowSpread) * arm,
            target.y - Math.sin(angle + arrowSpread) * arm,
          ])
        );
      }
    }
  }
  return marks;
}
