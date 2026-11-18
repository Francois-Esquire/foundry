import type { SpyglassData, SpyglassFile, Territory } from "../data/types";
import type { Chart, Described } from "./islands-api";

export type PickIdentity =
  | {
      kind: "island";
      id: string;
      name: string;
      files: number;
      unmatched: string[];
    }
  | {
      kind: "building";
      id: string;
      island: string | null;
      files: string[];
      unmatched: string[];
    }
  | {
      kind: "file";
      id: string;
      island: string | null;
      unmatched: string[];
    }
  | {
      kind: "bank";
      id: string;
      islands: string[];
      dependencies: { id: string; name: string; versions: readonly string[] }[];
      unmatched: string[];
    };

function filesIndex(
  data: Pick<SpyglassData, "territories">
): Map<string, { file: SpyglassFile; territory: Territory }> {
  const index = new Map<string, { file: SpyglassFile; territory: Territory }>();
  for (const territory of data.territories) {
    for (const file of territory.files) {
      index.set(file.id, { file, territory });
    }
  }
  return index;
}

function holderOf(
  files: readonly string[],
  index: ReadonlyMap<string, { territory: Territory }>
): Territory | null {
  const holders = new Set(
    files.flatMap((id) => {
      const found = index.get(id);
      return found ? [found.territory] : [];
    })
  );
  const [only] = holders;
  return holders.size === 1 && only ? only : null;
}

export function pickIdentity(
  described: Described,
  chart: Pick<Chart, "foundations" | "groups">,
  data: Pick<SpyglassData, "territories">
): PickIdentity {
  if (described.kind === "island") {
    const territory = data.territories.find((t) => t.id === described.id);
    return {
      files: territory?.files.length ?? 0,
      id: described.id,
      kind: "island",
      name: territory?.label ?? described.name,
      unmatched: territory ? [] : [described.id],
    };
  }
  if (described.kind === "ring") {
    const group = chart.groups.find((g) => g.id === described.id);
    const islands = group ? [...group.islands] : [];
    const known = new Set(data.territories.map((t) => t.id));
    return {
      dependencies: (group?.foundations ?? []).map((id) => {
        const foundation = chart.foundations.find((f) => f.id === id);
        return {
          id,
          name: foundation?.name ?? id,
          versions: foundation?.versions ?? [],
        };
      }),
      id: described.id,
      islands,
      kind: "bank",
      unmatched: group
        ? islands.filter((id) => !known.has(id))
        : [described.id],
    };
  }
  const files = [...(described.files ?? [])];
  const index = filesIndex(data);
  const unmatched = files.filter((id) => !index.has(id));
  const island = holderOf(files, index)?.id ?? null;
  if (described.kind === "module") {
    return { id: described.id, island, kind: "file", unmatched };
  }
  return { files, id: described.id, island, kind: "building", unmatched };
}

export function buildingSelection(
  described: Described,
  data: Pick<SpyglassData, "territories">
): { file?: SpyglassFile; territory: Territory } | null {
  const files = described.files ?? [];
  const index = filesIndex(data);
  const territory = holderOf(files, index);
  if (!territory) {
    return null;
  }
  const [only] = files;
  const file = files.length === 1 && only ? index.get(only)?.file : undefined;
  return file ? { file, territory } : { territory };
}
