import assert from "node:assert/strict";
import { qualifySpyglassData } from "../../src/web/data/types";
import { composeCollection } from "../../src/web/layout/collection";
import { loadSpyglass as referenceSpyglass } from "./reference-spyglass";

export const twinIds = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"] as const;

/** Two copies of one workspace, as a collection of two frames, with one crossing between them. */
export async function twins() {
  const [first, second] = await Promise.all([
    referenceSpyglass(),
    referenceSpyglass(),
  ]);
  const [from, to] = first.territories;
  assert(from && to);
  const crossing = {
    from: `${twinIds[0]}:${from.id}`,
    kind: "dependencies" as const,
    range: "^1.0.0",
    to: `${twinIds[1]}:${to.id}`,
  } as const;
  const spyglass = composeCollection(
    [
      qualifySpyglassData(first, { id: twinIds[0], label: "first" }),
      qualifySpyglassData(second, { id: twinIds[1], label: "second" }),
    ],
    [crossing]
  );
  return { single: await referenceSpyglass(), spyglass };
}
