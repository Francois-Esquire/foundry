import { describe, expect, it } from "vitest";
import { formerPackages } from "../../src/web/former-packages";
import type { AtlasData } from "../../src/web/types";

describe("former packages", () => {
  it("places only packages absent from the current survey using their last complete checkpoint", () => {
    const data = {
      height: 600,
      territories: [{ id: "current", radius: 80, x: 0, y: 0 }],
      width: 600,
    } as AtlasData;
    const manifest = {
      snapshots: [
        { commit: "old", status: "complete", timestamp: "2026-01-01" },
        { commit: "new", status: "complete", timestamp: "2026-03-01" },
        { commit: "failed", status: "failed", timestamp: "2026-04-01" },
      ],
    };
    const entities = {
      packages: [
        { checkpoints: ["old", "new", "failed"], id: "former" },
        { checkpoints: ["old"], id: "current" },
        { checkpoints: ["failed"], id: "unknown" },
      ],
    };
    const placed = formerPackages(data, manifest, entities);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.id).toBe("former");
    expect(placed[0]?.lastObserved).toBe("2026-03-01");
    for (const wreck of placed) {
      expect(Math.hypot(wreck.x, wreck.y)).toBeGreaterThan(108);
    }
    expect(formerPackages(data, manifest, entities)).toEqual(placed);
  });
});
