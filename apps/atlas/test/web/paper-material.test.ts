import { Texture } from "three";
import { describe, expect, it } from "vitest";

import {
  createPaperMaterials,
  paperThickness,
} from "../../src/web/scene/paper-material";

describe("atlas paper", () => {
  it("uses lit matte paper without bump or displacement", () => {
    const map = new Texture();
    const materials = createPaperMaterials(map);
    expect(materials.paper.map).toBe(map);
    // Directional light reveals slopes; vertex occlusion deepens valleys.
    expect(materials.paper.isMeshStandardNodeMaterial).toBe(true);
    expect(materials.paper.colorNode).toBeDefined();
    expect(paperThickness).toBe(0.4);
    let disposed = false;
    materials.paper.addEventListener("dispose", () => {
      disposed = true;
    });
    materials.dispose();
    expect(disposed).toBe(true);
    map.dispose();
  });
});
