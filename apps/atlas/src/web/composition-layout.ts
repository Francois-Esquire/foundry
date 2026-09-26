import type { InternalRewiringScenario } from "../lib/internal-rewiring-types";

export interface CompositionMark {
  group: string;
  id: string;
  x: number;
  y: number;
}

export type CompositionArrangement = "rows" | "clusters";

function clusterSites(count: number) {
  const radius = Math.ceil(Math.sqrt(count));
  const sites: { x: number; y: number }[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > radius) {
        continue;
      }
      sites.push({ x: 1.8 * (q + r / 2), y: (1.8 * r * Math.sqrt(3)) / 2 });
    }
  }
  return sites
    .sort(
      (a, b) =>
        a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y || a.y - b.y || a.x - b.x
    )
    .slice(0, count);
}

export function layoutScenarioComposition(
  marks: readonly CompositionMark[],
  scenario: Pick<InternalRewiringScenario, "proposed" | "subject" | "closure">
): CompositionMark[] {
  if (scenario.proposed.scope === "unchanged") {
    return [];
  }
  const separated = scenario.proposed.separated?.map((group, index) => ({
    id: `proposed:${index}`,
    symbols: group.symbolIds.map((symbolId) => ({ symbolId })),
  })) ?? [
    {
      id: "proposed",
      symbols: (scenario.subject.symbolIds ?? []).map((symbolId) => ({
        symbolId,
      })),
    },
  ];
  const known = new Set(marks.map((mark) => mark.id));
  const seen = new Set<string>();
  const groups = separated.map((group) => ({
    ...group,
    symbols: group.symbols.filter((symbol) => {
      if (!known.has(symbol.symbolId) || seen.has(symbol.symbolId)) {
        return false;
      }
      seen.add(symbol.symbolId);
      return true;
    }),
  }));
  const companions =
    scenario.closure?.required.filter(
      (item) => known.has(item.symbolId) && !seen.has(item.symbolId)
    ) ?? [];
  if (companions.length) {
    groups.push({
      id: "required-companions",
      symbols: companions.map((item) => ({ symbolId: item.symbolId })),
    });
  }
  const offset = Math.max(0, ...marks.map((mark) => mark.x)) + 7;
  const layout = layoutComposition(
    groups.filter((group) => group.symbols.length > 0)
  );
  const left = Math.min(0, ...layout.map((mark) => mark.x));
  return layout.map((mark) => ({ ...mark, x: mark.x - left + offset }));
}

export function layoutComposition(
  groups: readonly { id: string; symbols: readonly { symbolId: string }[] }[],
  arrangement: CompositionArrangement = "rows"
): CompositionMark[] {
  const result: CompositionMark[] = [];
  let row = 0;
  for (const group of [...groups].sort((a, b) => a.id.localeCompare(b.id))) {
    const symbols = [...group.symbols].sort((a, b) =>
      a.symbolId.localeCompare(b.symbolId)
    );
    const columns = Math.min(
      12,
      Math.max(1, Math.ceil(Math.sqrt(symbols.length)))
    );
    const sites =
      arrangement === "clusters"
        ? clusterSites(symbols.length)
        : symbols.map((_, index) => ({
            x: (index % columns) * 1.8,
            y: Math.floor(index / columns) * 1.8,
          }));
    const top = Math.min(0, ...sites.map((site) => site.y));
    symbols.forEach((symbol, index) => {
      const site = sites[index];
      if (!site) {
        return;
      }
      result.push({
        group: group.id,
        id: symbol.symbolId,
        x: site.x,
        y: row + site.y - top,
      });
    });
    row += Math.max(0, ...sites.map((site) => site.y)) - top + 5.4;
  }
  const width = Math.max(0, ...result.map((mark) => mark.x));
  const left = Math.min(0, ...result.map((mark) => mark.x));
  const height = Math.max(0, ...result.map((mark) => mark.y));
  return result.map((mark) => ({
    ...mark,
    x: mark.x - (width + left) / 2,
    y: mark.y - height / 2,
  }));
}
