import { expect, it } from "vitest";
import {
  defaultCoastSettings,
  previewShores,
} from "../../src/lib/visualization/coasts";
import { geologyLevels } from "../../src/lib/visualization/geology";
import { chartWorld } from "../../src/web/layout/chart-world";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** FNV-1a over a float field's bits: a fingerprint of its exact values. */
function fingerprint(values: Float32Array): string {
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
  let hash = 2_166_136_261;
  for (const word of bits) {
    // biome-ignore lint/suspicious/noBitwiseOperators: A 32-bit FNV-1a fingerprint of the field's bits.
    hash = Math.imul(hash ^ word, 16_777_619) >>> 0;
  }
  return hash.toString(16);
}

it("keeps the preview's coasts and land exactly as they look", async () => {
  // Captured from the reference chart. A change that only speeds the
  // build must leave all three; a change to the look updates them.
  const look = { coasts: "36feaaa7", land: "b01b50d3", samples: "6a8b3c19" };
  const data = await loadSpyglass();
  const { islands, landform, world } = chartWorld(data);
  expect(
    fingerprint(
      new Float32Array(islands.flatMap((island) => island.coast.flat(3)))
    )
  ).toBe(look.coasts);
  const land: number[] = [];
  const samples: number[] = [];
  for (const [at, distance] of world.signedDistance.entries()) {
    if (distance >= 0) {
      continue;
    }
    land.push(world.elevation[at] ?? 0);
    // Between the cell centres, as the finer lattice asks: no piece depth.
    samples.push(
      landform({
        inland: Math.max(0, -distance - 1),
        islandId: world.islandIds[world.owner[at] ?? -1] ?? "",
        x: world.left + ((at % world.width) + 0.75) * world.cell,
        y: world.top + (Math.floor(at / world.width) + 0.25) * world.cell,
      })
    );
  }
  expect(fingerprint(new Float32Array(land))).toBe(look.land);
  expect(fingerprint(new Float32Array(samples))).toBe(look.samples);
});

it("raises a sand bank under the water between each cay and its land", async () => {
  const data = await loadSpyglass();
  const { platform, world } = chartWorld(data);
  const { banks } = previewShores(data.territories, defaultCoastSettings);
  expect(banks.length).toBeGreaterThan(0);
  for (const bank of banks) {
    const x = (bank.from[0] + bank.to[0]) / 2;
    const y = (bank.from[1] + bank.to[1]) / 2;
    const at =
      Math.floor((y - world.top) / world.cell) * world.width +
      Math.floor((x - world.left) / world.cell);
    // Over the bank's middle the seabed stands shallower than the
    // platform beneath it, yet stays under the water.
    if ((world.signedDistance[at] ?? 0) >= 0) {
      expect(world.elevation[at]).toBeLessThan(geologyLevels.waterLevel);
      expect(world.elevation[at]).toBeGreaterThan(platform.seabed[at] ?? 0);
    }
  }
});
