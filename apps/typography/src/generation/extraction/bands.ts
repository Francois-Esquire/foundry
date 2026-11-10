/**
 * Finds the rows and columns of a sheet from where its ink is, and matches
 * them to the grid that was asked for. The asked-for grid is a hint: the
 * ink decides, and anything that does not fit is reported.
 */

/** A stretch of rows or columns that holds ink. `end` is exclusive. */
export interface Band {
  readonly end: number;
  readonly start: number;
}

export interface BandMatch {
  /** Bands that matched no slot. */
  readonly extra: readonly Band[];
  /** Runs of slots that one band covers, by first and last slot. */
  readonly merged: readonly (readonly [number, number])[];
  /** For each slot, the band found for it. */
  readonly slots: readonly (Band | undefined)[];
}

export const bandCentre = (band: Band) => (band.start + band.end) / 2;

/** Bands of the extents given, joined where the gap between them is small. */
export const bandsOf = (extents: readonly Band[], mergeGap: number): Band[] => {
  const bands: Band[] = [];
  for (const extent of extents.toSorted((a, b) => a.start - b.start)) {
    const last = bands.at(-1);
    if (last && extent.start - last.end <= mergeGap) {
      bands[bands.length - 1] = {
        end: Math.max(last.end, extent.end),
        start: last.start,
      };
    } else {
      bands.push(extent);
    }
  }
  return bands;
};

const nearestSlot = (centres: readonly number[], position: number): number => {
  let best = 0;
  for (let slot = 1; slot < centres.length; slot += 1) {
    if (
      Math.abs((centres[slot] ?? 0) - position) <
      Math.abs((centres[best] ?? 0) - position)
    ) {
      best = slot;
    }
  }
  return best;
};

/**
 * Matches bands to slots. When there are as many bands as slots they match
 * in order, however uneven the spacing. Otherwise each band takes the slot
 * whose expected centre is nearest, and the leftovers are reported.
 */
export const matchBands = (
  bands: readonly Band[],
  centres: readonly number[]
): BandMatch => {
  if (bands.length === centres.length) {
    return { extra: [], merged: [], slots: bands };
  }
  const slots: (Band | undefined)[] = centres.map(() => undefined);
  const extra: Band[] = [];
  const merged: (readonly [number, number])[] = [];
  for (const band of bands) {
    const covered = centres
      .map((position, index) =>
        position > band.start && position < band.end ? index : -1
      )
      .filter((index) => index >= 0);
    const [first] = covered;
    const last = covered.at(-1);
    if (first !== undefined && last !== undefined && last > first) {
      merged.push([first, last]);
      continue;
    }
    const slot = nearestSlot(centres, bandCentre(band));
    const holder = slots[slot];
    const centre = centres[slot] ?? 0;
    if (!holder) {
      slots[slot] = band;
    } else if (
      Math.abs(bandCentre(band) - centre) <
      Math.abs(bandCentre(holder) - centre)
    ) {
      extra.push(holder);
      slots[slot] = band;
    } else {
      extra.push(band);
    }
  }
  return { extra, merged, slots };
};
