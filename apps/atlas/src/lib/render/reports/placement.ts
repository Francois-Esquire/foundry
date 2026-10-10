import type {
  Placement,
  PlacementCounts,
  PlacementLevel,
  Placements,
} from "../../lenses/placement-types";
import { byId } from "../../workspace-projection";
import type { RenderDensity } from "../context";
import { LISTED_AT_DENSITY } from "../context";
import { count, percent } from "../format";
import type { BlockView, ReportView, SectionView } from "../views";

const LEVELS: { label: string; level: PlacementLevel }[] = [
  { label: "Symbols", level: "symbol" },
  { label: "Files", level: "file" },
  { label: "Folders", level: "folder" },
  { label: "Packages", level: "package" },
];

function awayModules(placement: Placement): number {
  return placement.away.reduce((sum, pkg) => sum + pkg.modules.length, 0);
}

function summed(lens: Placements, level: PlacementLevel): PlacementCounts {
  const total: PlacementCounts = {
    departs: 0,
    fits: 0,
    spread: 0,
    unconsumed: 0,
  };
  for (const pkg of lens.packages) {
    for (const label of Object.keys(total) as (keyof PlacementCounts)[]) {
      total[label] += pkg.counts[level][label];
    }
  }
  return total;
}

type Departure = Extract<Placement, { label: "departs" }>;

/** Places, the most consumer modules away first, then by place. */
function rankedSection<P extends Placement>(
  placements: P[],
  density: RenderDensity,
  title: string,
  detail: (placement: P) => string
): SectionView | undefined {
  const ranked = [...placements].sort(
    (a, b) => awayModules(b) - awayModules(a) || byId(a.place, b.place)
  );
  const shown = ranked.slice(0, LISTED_AT_DENSITY[density]);
  if (shown.length === 0) {
    return;
  }
  const list: BlockView = {
    items: shown.map((placement) => ({
      detail: [detail(placement)],
      label: placement.place,
      value: awayModules(placement),
    })),
    kind: "rankedList",
    ...(ranked.length > shown.length && {
      overflow: ranked.length - shown.length,
    }),
  };
  return { blocks: [list], title };
}

/** The `placement` lens: counts by level, then departures and spread places, the most used away first. */
export function buildPlacementView(
  lens: Placements,
  density: RenderDensity
): ReportView {
  const sections: SectionView[] = [
    {
      blocks: [
        {
          kind: "labelValue",
          rows: [
            {
              label: "Dominant share",
              value: percent(lens.policy.dominantShare),
            },
            ...LEVELS.map(({ label, level }) => {
              const counts = summed(lens, level);
              return {
                label,
                value: `${count(counts.departs)} depart, ${count(counts.spread)} spread, ${count(counts.fits)} fit, ${count(counts.unconsumed)} unconsumed`,
              };
            }),
          ],
        },
      ],
    },
  ];
  const home = (placement: Placement) =>
    `${count(placement.home.modules.length)} at home`;
  const departures = rankedSection(
    lens.places.filter(
      (placement): placement is Departure => placement.label === "departs"
    ),
    density,
    "Departures",
    (placement) =>
      `${placement.level} · ${placement.package} → ${placement.toward} · ${home(placement)}`
  );
  const spread = rankedSection(
    lens.places.filter((placement) => placement.label === "spread"),
    density,
    "Spread",
    (placement) =>
      `${placement.level} · ${placement.package} · ${count(placement.away.length)} packages away · ${home(placement)}`
  );
  for (const section of [departures, spread]) {
    if (section !== undefined) {
      sections.push(section);
    }
  }
  if (lens.missing.length > 0) {
    sections.push({
      blocks: [{ items: lens.missing, kind: "list" }],
      title: "Saved without internals",
    });
  }
  return { sections, title: "Placement" };
}
