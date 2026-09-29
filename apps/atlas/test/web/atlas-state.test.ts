import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AtlasMap } from "../../src/web/atlas-map";
import { createAtlasState } from "../../src/web/atlas-state";
import Atlas from "../../src/web/atlas-view";
import { defaultChartSettings } from "../../src/web/chart-settings";
import { loadAtlas } from "../helpers/reference-atlas";

it("retains the canonical survey and isolates mutable settings between maps", async () => {
  const data = await loadAtlas();
  const first = createAtlasState(data);
  const second = createAtlasState(data);
  first.chartSettings.layers.land = true;
  first.layoutSettings.coastalBuffer = 100;
  expect(first.data).toBe(data);
  expect(second.data).toBe(data);
  expect(second.chartSettings.layers.land).toBe(false);
  expect(defaultChartSettings.layers.land).toBe(false);
  expect(second.layoutSettings.coastalBuffer).toBe(
    defaultChartSettings.coastalBuffer
  );
  expect(first.chartSettings.boundaries).not.toBe(
    second.chartSettings.boundaries
  );
});

it("renders a map from explicit state without shell bindings or a provider", async () => {
  const state = createAtlasState(await loadAtlas());
  const markup = renderToStaticMarkup(createElement(AtlasMap, { state }));
  expect(markup).toContain('aria-label="Interactive atlas"');
  expect(markup).not.toContain("Find a place");
  expect(markup).not.toContain('aria-label="Map controls"');
  expect(markup).not.toContain("atlas-navigation");
});

it("composes the same map inside the shell or alone", async () => {
  const data = await loadAtlas();
  const full = renderToStaticMarkup(createElement(Atlas, { data }));
  const bare = renderToStaticMarkup(
    createElement(Atlas, { data, mapOnly: true })
  );
  expect(full).toContain("atlas-shell");
  expect(full).toContain('aria-label="Interactive atlas"');
  expect(full).toContain('aria-label="Map controls"');
  expect(bare).toContain('aria-label="Interactive atlas"');
  expect(bare).not.toContain("atlas-shell");
  expect(bare).not.toContain('aria-label="Map controls"');
});
