import { byCodeUnit } from "@foundry/lib/ordering";
import {
  qualifiedIn,
  type SpyglassData,
  type SpyglassFile,
  type SpyglassFrame,
  type Territory,
} from "./data/types";

/**
 * The ties drawn on one island of each kind, unless a file of it is
 * selected; a kind short of its share leaves the rest to the other.
 */
export const tiesByKind = { apart: 2, "co-change": 3 } as const;

interface Point {
  x: number;
  y: number;
}

/**
 * Something related that sits apart, drawn as a tie on its island: a file
 * apart from its responsibility's folder, tied to that folder; or two files
 * that change together from different folders, tied to each other.
 */
export interface ProximityTie {
  /** The files it ties, by file id: one for an apart file, two for a co-change. */
  files: readonly string[];
  from: Point;
  kind: "apart" | "co-change";
  package: string;
  to: Point;
}

/** A folder whose files fall into unrelated groups, marked at their centroid. */
interface CloseMark extends Point {
  folder: string;
  groups: number;
  package: string;
}

/** What the map draws of the `proximity` lens: every island's ties, ranked, and its close folders. */
export interface Proximities {
  marks: CloseMark[];
  /** By package, ranked: co-changes first, then apart files. */
  ties: ReadonlyMap<string, readonly ProximityTie[]>;
}

const byId = byCodeUnit((value: string) => value);

function world(territory: Territory, files: readonly SpyglassFile[]): Point {
  const count = Math.max(1, files.length);
  return {
    x: territory.x + files.reduce((sum, file) => sum + file.x, 0) / count,
    y: territory.y + files.reduce((sum, file) => sum + file.y, 0) / count,
  };
}

/** A folder's files: those directly in it, or, where it holds none, those below it. */
function folderFiles(territory: Territory, folder: string): SpyglassFile[] {
  const direct = territory.files.filter((file) => file.directory === folder);
  return direct.length
    ? direct
    : territory.files.filter((file) => file.directory.startsWith(`${folder}/`));
}

/** What the ties are worked out from. */
type ProximityData = Pick<SpyglassData, "frames" | "territories">;

const computed = new WeakMap<ProximityData, Proximities>();

/**
 * The ties and marks the map draws, once per spyglass. Co-changes across
 * packages are left to Place: drawn, they would cross the sea, which
 * departures hold.
 */
export function proximities(data: ProximityData): Proximities {
  const known = computed.get(data);
  if (known) {
    return known;
  }
  const territories = new Map(data.territories.map((t) => [t.id, t]));
  const ranked = new Map<string, ProximityTie[]>();
  const add = (tie: ProximityTie) => {
    ranked.set(tie.package, [...(ranked.get(tie.package) ?? []), tie]);
  };
  const marks: CloseMark[] = [];
  for (const frame of data.frames) {
    marks.push(...frameProximities(frame, territories, add));
  }
  const result: Proximities = { marks, ties: ranked };
  computed.set(data, result);
  return result;
}

/** One frame's ties, added as they rank, and its close folders' marks, from its own readings and islands. */
function frameProximities(
  frame: SpyglassFrame,
  territories: ReadonlyMap<string, Territory>,
  add: (tie: ProximityTie) => void
): CloseMark[] {
  const { proximity } = frame.readings;
  const own = frame.territories.flatMap((id) => {
    const territory = territories.get(id);
    return territory ? [territory] : [];
  });
  const paths = new Map(
    own.flatMap((territory) =>
      territory.files.map((file) => [file.path, { file, territory }] as const)
    )
  );
  const coChanges = proximity.apart.coChanges
    .filter((pair) => pair.scope === "same-package")
    .toSorted(
      (a, b) =>
        b.coChangeCommits - a.coChangeCommits ||
        b.jaccard - a.jaccard ||
        byId(a.id, b.id)
    );
  for (const pair of coChanges) {
    const left = paths.get(pair.left);
    const right = paths.get(pair.right);
    if (left && right && left.territory === right.territory) {
      add({
        files: [left.file.id, right.file.id],
        from: world(left.territory, [left.file]),
        kind: "co-change",
        package: left.territory.id,
        to: world(right.territory, [right.file]),
      });
    }
  }
  const apart = proximity.apart.files.toSorted(
    (a, b) => b.distance - a.distance || byId(a.file, b.file)
  );
  for (const entry of apart) {
    const at = paths.get(entry.file);
    const home = at && folderFiles(at.territory, entry.responsibilityFolder);
    if (at && home?.length) {
      add({
        files: [at.file.id],
        from: world(at.territory, [at.file]),
        kind: "apart",
        package: at.territory.id,
        to: world(at.territory, home),
      });
    }
  }
  return proximity.close.flatMap((folder) => {
    const island = qualifiedIn(frame, folder.package);
    const territory = territories.get(island);
    const files = territory && folderFiles(territory, folder.folder);
    return territory && files?.length
      ? [
          {
            folder: folder.folder,
            groups: folder.groups.length,
            package: island,
            ...world(territory, files),
          },
        ]
      : [];
  });
}

/**
 * The ties drawn on one island: every tie of the selected file when one of
 * the island's files is selected; else the strongest `tiesByKind` of each
 * kind, a kind short of its share leaving the rest to the other.
 */
export function drawnTies(
  data: ProximityData,
  island: string,
  selectedFile?: string | null
): readonly ProximityTie[] {
  const ties = proximities(data).ties.get(island) ?? [];
  const own = selectedFile
    ? ties.filter((tie) => tie.files.includes(selectedFile))
    : [];
  if (own.length) {
    return own;
  }
  const coChanges = ties.filter((tie) => tie.kind === "co-change");
  const apart = ties.filter((tie) => tie.kind === "apart");
  const budget = tiesByKind.apart + tiesByKind["co-change"];
  const coChangeShare = Math.max(
    tiesByKind["co-change"],
    budget - apart.length
  );
  const drawnCoChanges = coChanges.slice(0, coChangeShare);
  return [...drawnCoChanges, ...apart.slice(0, budget - drawnCoChanges.length)];
}

/** An island's ties: how many are drawn at rest, of all of them. */
export function tieCount(
  data: ProximityData,
  island: string
): { all: number; drawn: number } {
  return {
    all: proximities(data).ties.get(island)?.length ?? 0,
    drawn: drawnTies(data, island).length,
  };
}
