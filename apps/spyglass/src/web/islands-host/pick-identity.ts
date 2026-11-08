import type { SpyglassData, SpyglassFile, Territory } from "../data/types";
import type { Chart, Described } from "./islands-api";

/**
 * What a pick on the map names, in Spyglass's own terms: the package, the
 * building and the files in it, the file, or the bank and the dependencies
 * its packages share. Worked out from what Islands' "select" event gives
 * and the chart Spyglass handed it, so every id here is one the dataset
 * knows. `unmatched` lists what the event named that the dataset does not
 * have, which should stay empty.
 */
export type PickIdentity =
  | {
      kind: "island";
      /** The package's id. */
      id: string;
      name: string;
      files: number;
      unmatched: string[];
    }
  | {
      kind: "building";
      /** The building's id in the world plan, `building:<n>`. */
      id: string;
      /** The package it stands on. */
      island: string | null;
      /** Its files, by id: one household each. */
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
      /** The group's id. */
      id: string;
      /** The packages standing on it, by id. */
      islands: string[];
      /** The dependencies they all share. */
      dependencies: { id: string; name: string; versions: readonly string[] }[];
      unmatched: string[];
    };

/** Each file's package, by file id. */
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

/** The package that holds every one of `files`, or null when they are spread over several or none. */
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

/** What `described` names, checked against the dataset and the chart. */
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

/**
 * The viewer's selection for a building: its package, and its file when it
 * holds just one. A building whose files the dataset cannot place selects
 * nothing.
 */
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
