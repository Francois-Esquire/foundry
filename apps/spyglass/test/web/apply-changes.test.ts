import { expect, it, vi } from "vitest";
import { createApply } from "../../src/web/scene/apply-changes";
import { createViewState } from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { createSpyglassState } from "../../src/web/ui/spyglass-state";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** The overlay about one island's first file, with nothing else to resolve. */
function overlayOn(territoryId: string, fileId: string) {
  return {
    links: [],
    members: [fileId],
    pathDisagreement: [],
    related: [],
    territoryId,
    totalLinks: 0,
    unresolved: [],
  };
}

it("finds the overlay's matched region again when the drawing changes under it", async () => {
  const data = await loadSpyglass();
  const territory = data.territories.find((item) => item.files.length > 0);
  const file = territory?.files[0];
  if (!(territory && file)) {
    throw new Error("The fixture has no island with files.");
  }
  const state = createViewState(data, defaultChartSettings);
  const apply = createApply({
    configureRendering: vi.fn(),
    data,
    focus: vi.fn(),
    render: vi.fn(),
    setBelonging: vi.fn(),
    state,
  });
  const applied = {
    ...createSpyglassState(data),
    responsibility: overlayOn(territory.id, file.id),
  };
  apply(applied);
  expect(state.matches?.members.map((member) => member.id)).toEqual([file.id]);

  // Late readings move the file: the match now holds the file as drawn.
  const moved = {
    ...data,
    territories: data.territories.map((item) =>
      item.id === territory.id
        ? {
            ...item,
            files: item.files.map((candidate) =>
              candidate.id === file.id
                ? { ...candidate, x: candidate.x + 5 }
                : candidate
            ),
          }
        : item
    ),
  };
  apply({ ...applied, data: moved });
  expect(state.matches?.members[0]?.x).toBe(file.x + 5);

  // A relayout without the file leaves nothing to match.
  apply({
    ...applied,
    data: moved,
    territoryLayout: { ...territory, files: [] },
  });
  expect(state.matches).toBeUndefined();
});
