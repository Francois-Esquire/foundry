import { describe, expect, it } from "vitest";
import { formerPackages } from "../../src/web/former-packages";
import type { AtlasData } from "../../src/web/types";

describe("former packages", () => {
  it("places each retired package offshore, clear of current islands", () => {
    const data = {
      height: 600,
      territories: [{ id: "current", radius: 80, x: 0, y: 0 }],
      width: 600,
    } as AtlasData;
    const retired = [
      { id: "@scope/former", label: "former", lastSeen: "2026-03-01" },
    ];
    const placed = formerPackages(data, retired);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({
      id: "@scope/former",
      label: "former",
      lastObserved: "2026-03-01",
    });
    for (const wreck of placed) {
      expect(Math.hypot(wreck.x, wreck.y)).toBeGreaterThan(108);
    }
    expect(formerPackages(data, retired)).toEqual(placed);
  });
});
