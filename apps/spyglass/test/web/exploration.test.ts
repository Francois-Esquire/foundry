import { describe, expect, it } from "vitest";
import { visibleLabels } from "../../src/web/layout/label-candidates";
import type { MapLabel } from "../../src/web/layout/labels";
import { flatScreen } from "../helpers/label-screen";
import { loadSpyglass } from "../helpers/reference-spyglass";

describe("spyglass exploration", () => {
  it("keeps priority labels and rejects overlaps and offscreen labels", async () => {
    const territory = (await loadSpyglass()).territories.find(
      (item) => item.files.length > 0
    );
    const file = territory?.files[0];
    if (!(territory && file)) {
      throw new Error("Missing territory");
    }
    const label: MapLabel = {
      font: { face: "Georgia", letterSpacing: 0 },
      halo: 3,
      height: 10,
      ink: "#665e50",
      kind: "file",
      opacity: 1,
      place: { file, territory },
      territory,
      text: "first",
      width: 20,
      x: 0,
      y: 0,
      z: 0,
    };
    const candidates = [
      label,
      { ...label, text: "overlap", x: 5 },
      { ...label, text: "outside", x: 500 },
      { ...label, text: "separate", x: 35 },
    ];
    expect(
      visibleLabels(
        candidates,
        flatScreen({ height: 100, pixelsPerUnit: 1, width: 100, x: 0, y: 0 })
      ).map((l) => l.text)
    ).toEqual(["first", "separate"]);
  });
});
