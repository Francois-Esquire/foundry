import type { Territory } from "../data/types";
import { channels, grounds, packagePigments } from "../ladder/ink-ladder";
import { unit } from "./geography";

/** How much of the warm stock shows through an island's pigment. */
const paperWash = 0.48;

/** `over` laid on `under` at `alpha`, channel by channel in 8-bit sRGB, as a painter composites. */
function washed(under: string, over: string, alpha: number): string {
  const mixed = channels(under).map((base, i) =>
    Math.round(base + ((channels(over)[i] ?? 0) - base) * alpha)
  );
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * An island's flat colour: its pigment, chosen for it by its id so the same
 * island is always the same wash, under the shared warm paper. Blended in
 * sRGB as the coast sheet once was, so handing it to a colour-managed
 * material reads as the sheet's texel did.
 */
export function islandPigment(territory: Pick<Territory, "id">): string {
  const pigment =
    packagePigments[
      Math.floor(unit(`${territory.id}:pigment`) * packagePigments.length)
    ] ?? packagePigments[0];
  return washed(pigment, grounds.land, paperWash);
}
