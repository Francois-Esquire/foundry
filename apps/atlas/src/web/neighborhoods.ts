import type { FileRelationship } from "./relationships";
import type { AtlasFile } from "./types";

const findNeighborhoodsPattern = /\.[^.]+$/;

export interface Neighborhood {
  id: string;
  imports: number;
  label: string;
  members: string[];
  sharedConcepts: number;
}

export function findNeighborhoods(
  files: AtlasFile[],
  relationships: FileRelationship[]
): Neighborhood[] {
  const groups = new Map(
    [...files]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((f) => [
        f.id,
        {
          degree: 0,
          links: new Map<string, number>(),
          members: [f.id],
        },
      ])
  );
  for (const edge of relationships) {
    const a = groups.get(edge.source);
    const b = groups.get(edge.target);
    if (!(a && b)) {
      continue;
    }
    a.links.set(edge.target, edge.attraction);
    b.links.set(edge.source, edge.attraction);
    a.degree += edge.attraction;
    b.degree += edge.attraction;
  }
  const totalDegree = [...groups.values()].reduce((n, g) => n + g.degree, 0);
  findNeighborhoodsEntries(totalDegree, groups);
  const byId = new Map(files.map((f) => [f.id, f]));
  const neighborhoods = [...groups.entries()]
    .filter(([, g]) => g.members.length > 1)
    .map(([id, g]) => {
      const members = g.members.sort();
      const included = new Set(members);
      const internal = relationships.filter(
        (e) => included.has(e.source) && included.has(e.target)
      );
      const degrees = new Map(members.map((member) => [member, 0]));
      for (const e of internal) {
        for (const member of [e.source, e.target]) {
          degrees.set(member, (degrees.get(member) ?? 0) + e.attraction);
        }
      }
      const representative =
        [...members].sort(
          (a, b) =>
            (degrees.get(b) ?? 0) - (degrees.get(a) ?? 0) || a.localeCompare(b)
        )[0] ?? id;
      const path = byId.get(representative)?.path ?? representative;
      return {
        id,
        imports: internal.reduce((n, e) => n + e.imports, 0),
        label: path,
        members,
        sharedConcepts: new Set(internal.flatMap((e) => e.concepts)).size,
      };
    });
  const paths = neighborhoods.map((n) => n.label);
  for (const n of neighborhoods) {
    const segments = n.label.split("/");
    for (let count = 2; count <= segments.length; count += 1) {
      const suffix = segments.slice(-count).join("/");
      if (
        paths.filter((p) => p.endsWith(`/${suffix}`) || p === suffix).length ===
        1
      ) {
        n.label = suffix.replace(findNeighborhoodsPattern, "");
        break;
      }
    }
  }
  return neighborhoods.sort((a, b) => a.id.localeCompare(b.id));
}

function findNeighborhoodsEntries(
  totalDegree: number,
  groups: Map<
    string,
    { degree: number; links: Map<string, number>; members: string[] }
  >
) {
  while (totalDegree > 0) {
    let best: { left: string; right: string; gain: number } | undefined;
    best = findNeighborhoodsEntriesEntries(groups, totalDegree, best);
    if (!best) {
      break;
    }
    const a = groups.get(best.left);
    const b = groups.get(best.right);
    if (!(a && b)) {
      break;
    }
    a.members.push(...b.members);
    a.degree += b.degree;
    a.links.delete(best.right);
    for (const [neighbor, weight] of b.links) {
      if (neighbor === best.left) {
        continue;
      }
      const combined = (a.links.get(neighbor) ?? 0) + weight;
      a.links.set(neighbor, combined);
      const other = groups.get(neighbor);
      other?.links.delete(best.right);
      other?.links.set(best.left, combined);
    }
    groups.delete(best.right);
  }
}

function findNeighborhoodsEntriesEntries(
  groups: Map<
    string,
    { degree: number; links: Map<string, number>; members: string[] }
  >,
  totalDegree: number,
  initialBest: { left: string; right: string; gain: number } | undefined
): { left: string; right: string; gain: number } | undefined {
  let best = initialBest;
  for (const [left, a] of groups) {
    for (const [right, weight] of a.links) {
      if (left >= right) {
        continue;
      }
      const b = groups.get(right);
      if (!b) {
        continue;
      }
      const gain = weight - (a.degree * b.degree) / totalDegree;
      if (
        gain > 1e-9 &&
        (!best ||
          gain > best.gain + 1e-9 ||
          (Math.abs(gain - best.gain) < 1e-9 &&
            `${left}\0${right}` < `${best.left}\0${best.right}`))
      ) {
        best = { gain, left, right };
      }
    }
  }
  return best;
}
