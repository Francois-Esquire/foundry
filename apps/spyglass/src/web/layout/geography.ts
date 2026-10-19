import { positionFoundations } from "../../lib/visualization/foundations";
import {
  chartSize,
  middleOf,
  reach,
  settlePackages,
} from "../../lib/visualization/geography";
import { prepareFoundationGroups } from "../../lib/visualization/groups";
import {
  islandsByFrame,
  type SpyglassData,
  type Territory,
} from "../data/types";
import { archipelagoHull } from "./archipelago";

/** Open water kept between one frame's rim and the next, in map units. */
export const frameSea = 120;

/** How far a frame's islands move, all together, to take their place in a collection. */
export interface FrameOffset {
  dx: number;
  dy: number;
}

/**
 * A collection's frames side by side. Each frame's islands are laid out as
 * their workspace's alone would be (`settlePackages`) and moved whole, so
 * its own layout is kept. The frames run west to east in the collection's
 * order, with `frameSea` of open water between one frame's rim
 * (`archipelagoHull`) and the next. Each frame retains its original
 * two-dimensional dependency geography. One offset centres the collection.
 * Each frame's offset, in order.
 */
export function sideBySide(
  frames: readonly (readonly Territory[])[]
): FrameOffset[] {
  // The east edge of the rims placed so far; none before the first.
  let east: number | undefined;
  const columns = frames.map((islands) => {
    const xs = archipelagoHull({ territories: [...islands] }).map(
      ([west]) => west
    );
    if (!xs.length) {
      return 0;
    }
    const dx =
      east === undefined ? -Math.min(...xs) : east + frameSea - Math.min(...xs);
    east = dx + Math.max(...xs);
    return dx;
  });
  const placed = frames.flatMap((islands, i) =>
    islands.map((p) => ({
      ...p,
      x: p.x + (columns[i] ?? 0),
      y: p.y,
    }))
  );
  const [x, y] = placed.length ? middleOf(placed, reach) : [0, 0];
  return frames.map((_, i) => ({
    dx: (columns[i] ?? 0) - x,
    dy: -y,
  }));
}

/**
 * The spyglass with its islands placed again at another clearance; coasts and
 * file positions are unchanged. A collection's frames are placed again one
 * by one and set side by side
 * again (`sideBySide`); their former packages move with them.
 */
export function relayoutSpyglass(
  data: SpyglassData,
  clearance: number,
  foundationInfluence = data.foundationInfluence ?? 1
): SpyglassData {
  const influence = Number.isFinite(foundationInfluence)
    ? Math.max(0, Math.min(1, foundationInfluence))
    : 0;
  if (data.frames.length <= 1) {
    const territories = data.territories.map((p) => ({ ...p }));
    settlePackages(
      territories,
      data.packageLayers,
      clearance,
      data.routes,
      data.foundations,
      influence
    );
    return {
      ...data,
      ...chartSize(territories),
      foundationInfluence: influence,
      ...foundationLayout(data, territories),
      territories,
    };
  }
  const before = islandsByFrame(data);
  const alone = before.map((islands) => {
    const copies = islands.map((p) => ({ ...p }));
    settlePackages(
      copies,
      data.packageLayers,
      clearance,
      data.routes,
      data.foundations,
      influence
    );
    return copies;
  });
  const offsets = sideBySide(alone);
  const after = alone.map((islands, i) => {
    const { dx = 0, dy = 0 } = offsets[i] ?? {};
    return islands.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
  });
  const territories = after.flat();
  // A former package moves as far as its frame's middle does.
  const moved = (id: string): [number, number] => {
    const at = data.frames.findIndex((frame) => id.startsWith(`${frame.id}:`));
    if (at < 0) {
      return [0, 0];
    }
    const [x0, y0] = frameMiddle(before[at] ?? []);
    const [x1, y1] = frameMiddle(after[at] ?? []);
    return [x1 - x0, y1 - y0];
  };
  return {
    ...data,
    ...chartSize(territories),
    foundationInfluence: influence,
    ...foundationLayout(data, territories),
    ...(data.formerPackages && {
      formerPackages: data.formerPackages.map((former) => {
        const [dx, dy] = moved(former.id);
        return { ...former, x: former.x + dx, y: former.y + dy };
      }),
    }),
    territories,
  };
}

/** Where a frame's islands sit now: the middle of their extent. */
function frameMiddle(islands: readonly Territory[]): [number, number] {
  if (!islands.length) {
    return [0, 0];
  }
  const middle = (low: number[], high: number[]) =>
    (Math.min(...low) + Math.max(...high)) / 2;
  return [
    middle(
      islands.map((p) => p.x - p.radius),
      islands.map((p) => p.x + p.radius)
    ),
    middle(
      islands.map((p) => p.y - p.radius),
      islands.map((p) => p.y + p.radius)
    ),
  ];
}

export function territoryLabelY(territory: Territory): number {
  return (
    Math.min(
      0,
      ...territory.coast.flatMap((p) => p[0]?.map((point) => point[1]) ?? [])
    ) - 17
  );
}

/** Layout changes replace both layers of derived geometry together. */
function foundationLayout(data: SpyglassData, territories: Territory[]) {
  if (!data.foundations) {
    return {};
  }
  const foundations = positionFoundations(data.foundations, territories);
  return {
    foundationGroups: prepareFoundationGroups(foundations),
    foundations,
  };
}
