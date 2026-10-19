import { DataUtils, HalfFloatType, LinearFilter, RedFormat } from "three";
import { expect, it } from "vitest";
import type { SpyglassFoundation } from "../../src/web/data/types";
import { createFoundationTexture } from "../../src/web/scene/foundation-material";

const foundation: SpyglassFoundation = {
  id: "dependency:zod",
  lobes: [{ radius: 30, territoryId: "a", weight: 1, x: 0, y: -60 }],
  members: [{ direct: true, distance: 1, territoryId: "a", weight: 1 }],
  name: "zod",
  prominence: 1,
  versions: ["4.0.0"],
  x: 0,
  y: -60,
};

it("keeps chart row orientation and updates the same texture only when focus changes", () => {
  const field = createFoundationTexture([foundation], {
    height: 200,
    width: 200,
  });
  const { texture } = field;
  expect(texture.type).toBe(HalfFloatType);
  expect(texture.format).toBe(RedFormat);
  expect(texture.minFilter).toBe(LinearFilter);
  const data = texture.image.data as Uint16Array;
  const initial = data.slice();
  const { width } = texture.image;
  const upper = DataUtils.fromHalfFloat(
    data[Math.floor(width * 0.2) * width + Math.floor(width / 2)] ?? 0
  );
  const lower = DataUtils.fromHalfFloat(
    data[Math.floor(width * 0.8) * width + Math.floor(width / 2)] ?? 0
  );
  expect(upper).toBeGreaterThan(0.5);
  expect(lower).toBe(0);
  const { version } = texture;
  field.setFocus("");
  expect(texture.version).toBe(version);
  field.setFocus("missing");
  expect(texture.image.data).toBe(data);
  expect(data.every((value) => value === 0)).toBe(true);
  field.setFocus(foundation.id);
  expect(data).toEqual(initial);
  field.setFocus("");
  expect(data).toEqual(initial);
  let disposed = false;
  texture.addEventListener("dispose", () => {
    disposed = true;
  });
  texture.dispose();
  expect(disposed).toBe(true);
});
