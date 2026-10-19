import type { Territory } from "../data/types";
import { inks } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import type { Glyph } from "./marks";
import { glyphOn } from "./marks";

/** The selected file's ring: its radius, the selection's pen round it, and the centre square's side, in CSS pixels. */
const focusRing = { centre: 4, pen: 2, radius: 9 } as const;

/**
 * The selected file's focus, above every other mark on its island and round
 * on screen under the tilt's stretch: the paper halo cut round its ring, the
 * ring in the selection's ink, and a square at its centre. Nothing without
 * a selected file on the selected island.
 */
export function focusMarks(
  territories: readonly Territory[],
  selected: string | null,
  fileId: string | null
): Glyph[] {
  const territory = territories.find((item) => item.id === selected);
  const file = territory?.files.find((item) => item.id === fileId);
  if (!(territory && file)) {
    return [];
  }
  const halo = inkStyle("focus-halo");
  const upright = { alpha: 1, upright: true } as const;
  return [
    glyphOn(territory, file, {
      ...upright,
      colour: inks.focusHalo,
      shape: "hoop",
      size: 2 * focusRing.radius,
      weight: halo.weight,
    }),
    glyphOn(territory, file, {
      ...upright,
      colour: inks.selection,
      shape: "hoop",
      size: 2 * focusRing.radius,
      weight: focusRing.pen,
    }),
    glyphOn(territory, file, {
      ...upright,
      colour: inks.selection,
      shape: "square",
      size: focusRing.centre,
    }),
  ];
}
