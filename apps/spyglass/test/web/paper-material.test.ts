import { Color } from "three";
import { describe, expect, it } from "vitest";

import { paperThickness } from "../../src/web/data/bindings";
import { createClock } from "../../src/web/scene/clock";
import { createPaperMaterials } from "../../src/web/scene/paper-material";
import { pigmentAttribute } from "../../src/web/scene/terrain";
import { createWeatherLayer } from "../../src/web/scene/weather";

describe("spyglass paper", () => {
  it("uses lit matte paper without a texture, bump or displacement", () => {
    const materials = createPaperMaterials(createWeatherLayer(createClock()));
    expect(materials.paper.map).toBeNull();
    // Directional light reveals slopes; vertex occlusion deepens valleys;
    // each mesh brings its pigment.
    expect(materials.paper.isMeshStandardNodeMaterial).toBe(true);
    expect(materials.paper.colorNode).toBeDefined();
    expect(paperThickness).toBe(0.4);
    let disposed = false;
    materials.paper.addEventListener("dispose", () => {
      disposed = true;
    });
    materials.dispose();
    expect(disposed).toBe(true);
  });
  it("carries a pigment as the working-space colour of every vertex", () => {
    const pigment = pigmentAttribute(3, "#f1ead9");
    const { r, g, b } = new Color("#f1ead9");
    expect(pigment.itemSize).toBe(3);
    expect(pigment.count).toBe(3);
    for (let i = 0; i < 3; i += 1) {
      expect([pigment.getX(i), pigment.getY(i), pigment.getZ(i)]).toEqual(
        [r, g, b].map(Math.fround)
      );
    }
    // Converted from sRGB, as a texel of an sRGB texture is when sampled.
    expect(r).toBeLessThan(0xf1 / 255);
  });
});
