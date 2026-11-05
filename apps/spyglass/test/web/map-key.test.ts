import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MapKey } from "../../src/web/ui/map-key";
import { createSpyglassState } from "../../src/web/ui/spyglass-state";
import { loadSpyglass } from "../helpers/reference-spyglass";

async function state() {
  return createSpyglassState(await loadSpyglass());
}

it("leads with what the islands mean, and has no controls", async () => {
  const html = renderToStaticMarkup(
    createElement(MapKey, { state: await state() })
  );
  expect(html).toContain("Islands are packages.");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<input");
});

it("names the shared banks only for a spyglass with foundations", async () => {
  const current = await state();
  const withBanks = renderToStaticMarkup(
    createElement(MapKey, {
      state: {
        ...current,
        data: {
          ...current.data,
          foundations: current.data.foundations?.length
            ? current.data.foundations
            : [{} as never],
        },
      },
    })
  );
  expect(withBanks).toContain("Shallow banks are shared dependencies.");
  const without = renderToStaticMarkup(
    createElement(MapKey, {
      state: { ...current, data: { ...current.data, foundations: [] } },
    })
  );
  expect(without).not.toContain("Shallow banks");
});

it("says how to leave a selection", async () => {
  const current = await state();
  const html = renderToStaticMarkup(
    createElement(MapKey, {
      state: { ...current, selection: { territoryId: "any" } },
    })
  );
  expect(html).toContain("Escape returns to the whole map.");
});
