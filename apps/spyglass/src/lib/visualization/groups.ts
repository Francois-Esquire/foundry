import { contours } from "d3-contour";
import { coastField } from "./coast-field";
import type {
  DependencyFoundation,
  FoundationGroup,
  IslandGeometry,
  Polygon,
} from "./types";

type Lobe = DependencyFoundation["lobes"][number];
type CoastFields = ReadonlyMap<string, ReturnType<typeof coastField>>;

/** Group identity follows membership, never geometry, focus, or input order. */
export function foundationGroupId(memberIds: readonly string[]): string {
  return `foundation-group:${JSON.stringify([...new Set(memberIds)].sort())}`;
}

/** Exact membership sets coalesce; partial overlaps retain separate identities. */
export function prepareFoundationGroups(
  foundations: readonly DependencyFoundation[],
  islands: readonly IslandGeometry[] = []
): FoundationGroup[] {
  const coasts: CoastFields = new Map(
    islands.map((island) => [
      island.id,
      coastField(island, 160 + island.radius),
    ])
  );
  const memberships = new Map<string, DependencyFoundation[]>();
  for (const foundation of foundations) {
    const members = [
      ...new Set(foundation.members.map((member) => member.territoryId)),
    ].sort();
    if (members.length < 2) {
      continue;
    }
    const key = JSON.stringify(members);
    const group = memberships.get(key) ?? [];
    group.push(foundation);
    memberships.set(key, group);
  }
  return [...memberships]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, dependencies]) => {
      const lobes = new Map<string, Lobe>();
      for (const dependency of dependencies) {
        for (const lobe of dependency.lobes) {
          const previous = lobes.get(lobe.territoryId);
          if (!previous || lobe.radius > previous.radius) {
            lobes.set(lobe.territoryId, lobe);
          }
        }
      }
      const slices = groupSlices(
        [...lobes.values()].sort((a, b) =>
          a.territoryId.localeCompare(b.territoryId)
        ),
        coasts
      );
      return {
        dependencyIds: dependencies.map((dependency) => dependency.id).sort(),
        footprint: slices[0] ?? [],
        id: foundationGroupId(JSON.parse(key) as string[]),
        memberIds: JSON.parse(key) as string[],
        slices,
      };
    });
}

/** Broad coast fields merge naturally. No graph edges are used as terrain geometry. */
function groupSlices(
  source: readonly Lobe[],
  coasts: CoastFields
): Polygon[][] {
  if (source.length < 2) {
    return [];
  }
  const lobes = source.map((lobe) => {
    const coast = coasts.get(lobe.territoryId);
    const radius = coast?.radius ?? lobe.radius;
    return { ...lobe, coast, radius, spread: 70 + radius * 0.4 };
  });
  const left = Math.min(
    ...lobes.map((lobe) => lobe.x - lobe.radius - lobe.spread * 2.6)
  );
  const top = Math.min(
    ...lobes.map((lobe) => lobe.y - lobe.radius - lobe.spread * 2.6)
  );
  const spanX =
    Math.max(...lobes.map((lobe) => lobe.x + lobe.radius + lobe.spread * 2.6)) -
    left;
  const spanY =
    Math.max(...lobes.map((lobe) => lobe.y + lobe.radius + lobe.spread * 2.6)) -
    top;
  const scale = 256 / Math.max(spanX, spanY, 1);
  const width = Math.max(2, Math.ceil(spanX * scale));
  const height = Math.max(2, Math.ceil(spanY * scale));
  const values = new Array<number>(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const worldX = left + ((col + 0.5) / width) * spanX;
      const worldY = top + ((row + 0.5) / height) * spanY;
      const x =
        worldX + 5 * Math.sin(worldY * 0.019) + 3 * Math.sin(worldX * 0.037);
      const y =
        worldY + 5 * Math.sin(worldX * 0.017) + 3 * Math.sin(worldY * 0.041);
      let complement = 1;
      for (const lobe of lobes) {
        const distance = lobe.coast
          ? lobe.coast.distance(x, y)
          : Math.max(0, Math.hypot(x - lobe.x, y - lobe.y) - lobe.radius);
        complement *= 1 - Math.exp(-((distance / lobe.spread) ** 2));
      }
      // Probabilistic union bounds each shared plane to [0, 1], independent
      // of consumer count. Partial overlaps between groups remain distinct.
      values[row * width + col] = 1 - complement;
    }
  }
  return contours()
    .size([width, height])
    .thresholds([0.12, 0.26, 0.42, 0.58, 0.74, 0.9])(values)
    .map((contour) =>
      contour.coordinates.map((polygon) =>
        polygon.map((ring) =>
          ring.map(([x = 0, y = 0]): [number, number] => [
            left + (x / width) * spanX,
            top + (y / height) * spanY,
          ])
        )
      )
    );
}
