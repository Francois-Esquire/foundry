import { byCodeUnit } from "@foundry/lib/ordering";
import type { CodexPlacement } from "./codex/vocabulary";
import type { AtlasData, AtlasFile, Territory } from "./types";

/** The most departure lines drawn into any one package. */
export const linesPerTarget = 3;
/** The fewest consumer modules in the target package a line must rest on to be drawn. */
export const leastConsumers = 2;

interface Point {
  x: number;
  y: number;
}

/** A departing file, folder, or package, where the map marks it. */
interface DepartureMark extends Point {
  /** Consumer modules in the package it departs toward. */
  consumers: number;
  level: "file" | "folder" | "package";
  /** The package it lives in, by id. */
  package: string;
  place: string;
  share: number;
  /** The package it departs toward, by id. */
  toward: string;
}

/**
 * One line of departures: the departing places of one folder toward one
 * package, or a folded package toward its one consumer. `from` is the
 * centroid of their marks, in world units.
 */
interface DepartureLine {
  /**
   * Consumer modules in the target that the line rests on: its members'
   * most, a floor on the distinct ones, since two places can share a
   * consumer.
   */
  consumers: number;
  /** The folder: a departing folder's own path, a file's directory, a folded package's root. */
  folder: string;
  from: Point;
  /** Its broadest member's level. */
  level: DepartureMark["level"];
  /** The package the places live in, by id. */
  package: string;
  /** Sorted by code unit. */
  places: string[];
  /** The strongest member's dominance share, which ranks the line. */
  share: number;
  toward: string;
}

/** What the map draws of the `placement` lens, and what it leaves out, for the legend to disclose. */
export interface Departures {
  /** Ranked, resting on at least `leastConsumers`, at most `linesPerTarget` into each package. */
  lines: DepartureLine[];
  marks: DepartureMark[];
  totals: {
    /** Lines before the threshold and the cap. */
    candidateLines: number;
    /** Lines left undrawn for resting on fewer than `leastConsumers` consumer modules. */
    thinLines: number;
    /** Departing files, folders, and packages, folded ones' places included. */
    departing: number;
    /** Packages whose only consumer is one other package, drawn as one mark. */
    folded: number;
    /** Departing symbols, which Place tells and the map does not draw. */
    symbols: number;
  };
}

const byPlace = byCodeUnit((place: string) => place);

/** The broadest place first: a whole package, then a folder, then files. */
const breadth: Record<DepartureMark["level"], number> = {
  file: 2,
  folder: 1,
  package: 0,
};

/**
 * Line rank: the strongest member's dominance share; on a tie, the
 * evidence, its consumer modules in the target; then the broadest place,
 * since a package or folder departing as a whole says more than files; then
 * the most departing places; then folder and target by code unit.
 */
function byRank(a: DepartureLine, b: DepartureLine): number {
  return (
    b.share - a.share ||
    b.consumers - a.consumers ||
    breadth[a.level] - breadth[b.level] ||
    b.places.length - a.places.length ||
    byPlace(a.folder, b.folder) ||
    byPlace(a.toward, b.toward)
  );
}

function centroid(points: readonly Point[]): Point {
  const count = Math.max(1, points.length);
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / count,
    y: points.reduce((sum, point) => sum + point.y, 0) / count,
  };
}

function worldOf(territory: Territory, files: readonly AtlasFile[]): Point {
  const at = centroid(files);
  return { x: territory.x + at.x, y: territory.y + at.y };
}

/** A departing place's mark, or none when its files are not on the map. */
function markOf(
  placement: CodexPlacement & { toward: string },
  territory: Territory
): DepartureMark | undefined {
  const { level, place } = placement;
  if (level === "symbol") {
    return;
  }
  const files = territory.files.filter((file) => {
    if (level === "file") {
      return file.path === place;
    }
    return level === "package" || file.path.startsWith(`${place}/`);
  });
  if (!files.length) {
    return;
  }
  return {
    consumers:
      placement.away.find((entry) => entry.package === placement.toward)
        ?.modules ?? 0,
    level,
    package: placement.package,
    place,
    share: placement.share,
    toward: placement.toward,
    ...worldOf(territory, files),
  };
}

function departing(
  placement: CodexPlacement
): placement is CodexPlacement & { toward: string } {
  return placement.label === "departs" && placement.toward !== undefined;
}

/** A package whose only consumer is one other package: fold-package territory. */
function folds(placement: CodexPlacement): boolean {
  return placement.level === "package" && placement.away.length === 1;
}

const computed = new WeakMap<AtlasData, Departures>();

/**
 * The departures the map draws, from the `placement` lens: a mark on every
 * departing file and folder, except that a package whose only consumer is
 * one other package gets one mark for the package and none for its places;
 * and lines grouped by (folder → consumer package), ranked, each resting on
 * at least `leastConsumers` consumer modules in its target, at most
 * `linesPerTarget` into each package. Deterministic, and computed once per
 * atlas.
 */
export function departures(data: AtlasData): Departures {
  const known = computed.get(data);
  if (known) {
    return known;
  }
  const territories = new Map(data.territories.map((t) => [t.id, t]));
  const places = Object.values(data.placement.places)
    .filter(departing)
    .sort((a, b) => byPlace(a.place, b.place));
  const folded = new Set(places.filter(folds).map((p) => p.package));
  const marks = places.flatMap((placement) => {
    const territory = territories.get(placement.package);
    const absorbed =
      folded.has(placement.package) && placement.level !== "package";
    const mark = territory && !absorbed && markOf(placement, territory);
    return mark ? [mark] : [];
  });
  const groups = new Map<string, DepartureMark[]>();
  for (const mark of marks) {
    const folder =
      mark.level === "file"
        ? mark.place.slice(0, mark.place.lastIndexOf("/"))
        : mark.place;
    const key = JSON.stringify([mark.package, folder, mark.toward]);
    groups.set(key, [...(groups.get(key) ?? []), mark]);
  }
  const candidates = [...groups].map(([key, members]): DepartureLine => {
    const [pkg = "", folder = "", toward = ""] = JSON.parse(key) as string[];
    return {
      consumers: Math.max(...members.map((mark) => mark.consumers)),
      folder,
      from: centroid(members),
      level: members.reduce(
        (broadest: DepartureMark["level"], mark) =>
          breadth[mark.level] < breadth[broadest] ? mark.level : broadest,
        "file"
      ),
      package: pkg,
      places: members.map((mark) => mark.place).sort(byPlace),
      share: Math.max(...members.map((mark) => mark.share)),
      toward,
    };
  });
  const drawn = new Map<string, number>();
  const evident = candidates.filter((line) => line.consumers >= leastConsumers);
  const lines = evident.sort(byRank).filter((line) => {
    const count = drawn.get(line.toward) ?? 0;
    drawn.set(line.toward, count + 1);
    return count < linesPerTarget;
  });
  const result: Departures = {
    lines,
    marks,
    totals: {
      candidateLines: candidates.length,
      departing: places.filter((p) => p.level !== "symbol").length,
      folded: folded.size,
      symbols: places.filter((p) => p.level === "symbol").length,
      thinLines: candidates.length - evident.length,
    },
  };
  computed.set(data, result);
  return result;
}
