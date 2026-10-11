import assert from "node:assert/strict";
import { composeCollection } from "../../src/web/collection";
import { qualifyAtlasData } from "../../src/web/types";
import { loadAtlas as referenceAtlas } from "./reference-atlas";

export const twinIds = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"] as const;

/** Two copies of one workspace, as a collection of two frames, with one crossing between them. */
export async function twins() {
  const [first, second] = await Promise.all([
    referenceAtlas(),
    referenceAtlas(),
  ]);
  const [from, to] = first.territories;
  assert(from && to);
  const crossing = {
    from: `${twinIds[0]}:${from.id}`,
    kind: "dependencies" as const,
    range: "^1.0.0",
    to: `${twinIds[1]}:${to.id}`,
  } as const;
  const atlas = composeCollection(
    [
      qualifyAtlasData(first, { id: twinIds[0], label: "first" }),
      qualifyAtlasData(second, { id: twinIds[1], label: "second" }),
    ],
    [crossing]
  );
  return { atlas, single: await referenceAtlas() };
}
