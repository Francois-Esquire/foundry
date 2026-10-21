import {
  type DependencyFoundation,
  type IslandGeometry,
  maximumFoundationInfluence,
} from "./types";

type Island = Pick<IslandGeometry, "id" | "x" | "y" | "radius">;
interface Affinity {
  a: Island;
  b: Island;
  distance: number;
  shared: number;
}

/** Count shared reliance between pairs, discounting distant paths and ubiquitous libraries. */
function sharedAffinities(
  foundations: readonly DependencyFoundation[],
  territories: readonly Island[]
): Affinity[] {
  const islands = new Map(territories.map((island) => [island.id, island]));
  const pairs = new Map<string, Affinity>();
  for (const foundation of [...foundations].sort((a, b) =>
    a.id.localeCompare(b.id)
  )) {
    const members = foundation.members
      .filter(
        (member) =>
          islands.has(member.territoryId) &&
          Number.isFinite(member.weight) &&
          member.weight > 0
      )
      .sort((a, b) => a.territoryId.localeCompare(b.territoryId));
    for (const [index, first] of members.entries()) {
      for (const second of members.slice(index + 1)) {
        const a = islands.get(first.territoryId);
        const b = islands.get(second.territoryId);
        if (!(a && b) || a === b) {
          continue;
        }
        const key = JSON.stringify([a.id, b.id]);
        const pair = pairs.get(key) ?? {
          a,
          b,
          distance: Math.hypot(b.x - a.x, b.y - a.y),
          shared: 0,
        };
        pair.shared +=
          Math.min(first.weight, second.weight) /
          Math.max(1, members.length - 1);
        pairs.set(key, pair);
      }
    }
  }
  return [...pairs.values()].sort(
    (a, b) => a.a.id.localeCompare(b.a.id) || a.b.id.localeCompare(b.b.id)
  );
}

/** More shared dependencies strengthen a pair's pull without allowing unbounded collapse. */
export function createFoundationAttraction(
  foundations: readonly DependencyFoundation[],
  territories: readonly Island[],
  influence: number
): { apply: () => void; connected: ReadonlySet<string> } {
  const strength = Number.isFinite(influence)
    ? Math.max(0, Math.min(maximumFoundationInfluence, influence))
    : 0;
  const pairs = strength > 0 ? sharedAffinities(foundations, territories) : [];
  const connected = new Set(pairs.flatMap(({ a, b }) => [a.id, b.id]));
  return {
    apply() {
      const forces = new Map<
        Island,
        { x: number; y: number; weight: number }
      >();
      for (const { a, b, shared, distance: baseline } of pairs) {
        // Saturation preserves the distinction between one and several shared
        // dependencies, while hundreds of transitive dependencies stay bounded.
        const affinity = 1 - Math.exp((-shared * strength) / 4);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        // Shared overlap contracts this pair's baseline distance, at most halfway.
        // Unshared pairs have no spring; this is not a global packing setting.
        const distance = Math.hypot(dx, dy) || 1;
        const target = baseline * (1 - 0.5 * affinity);
        const pull = Math.max(0, distance - target) / distance;
        for (const [island, direction] of [
          [a, 1],
          [b, -1],
        ] as const) {
          const force = forces.get(island) ?? { weight: 0, x: 0, y: 0 };
          force.x += dx * pull * direction;
          force.y += dy * pull * direction;
          force.weight += affinity;
          forces.set(island, force);
        }
      }
      for (const [island, force] of forces) {
        const scale = 0.025 / Math.max(1, force.weight / 2);
        const dx = force.x * scale;
        const dy = force.y * scale;
        const cap = Math.min(
          1,
          (3 * Math.max(1, strength)) / (Math.hypot(dx, dy) || 1)
        );
        island.x += dx * cap;
        island.y += dy * cap;
      }
    },
    connected,
  };
}
