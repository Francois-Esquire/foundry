import { Texture } from "three";
import { describe, expect, it } from "vitest";

import {
  createPaperMaterials,
  paperThickness,
} from "../../src/web/scene/paper-material";

describe("atlas paper", () => {
  it("uses matte solid pigment without decorative bump or displacement", () => {
    const map = new Texture();
    const materials = createPaperMaterials(map);
    expect(materials.paper.map).toBe(map);
    expect(materials.paper.isMeshBasicNodeMaterial).toBe(true);
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
