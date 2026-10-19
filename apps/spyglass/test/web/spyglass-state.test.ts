import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { SpyglassMap } from "../../src/web/ui/spyglass-map";
import { createSpyglassState } from "../../src/web/ui/spyglass-state";
import Spyglass from "../../src/web/ui/spyglass-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

it("retains the canonical survey and isolates mutable settings between maps", async () => {
  const data = await loadSpyglass();
  const first = createSpyglassState(data);
  const second = createSpyglassState(data);
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
  first.chartSettings.composition.hidden = ["labels"];
  expect(second.chartSettings.composition.hidden).toEqual([]);
  expect(defaultChartSettings.composition.hidden).toEqual([]);
});

it("renders a map from explicit state without shell bindings or a provider", async () => {
  const state = createSpyglassState(await loadSpyglass());
  const markup = renderToStaticMarkup(
    createElement(SpyglassMap, {
      onEscape: vi.fn(),
      onSelect: vi.fn(),
      state,
    })
  );
  expect(markup).toContain('aria-label="Interactive spyglass"');
  expect(markup).not.toContain("Find a place");
  expect(markup).not.toContain('aria-label="Spyglass controls"');
  expect(markup).not.toContain("spyglass-navigation");
});

it("composes the same map inside the shell or alone", async () => {
  const data = await loadSpyglass();
  const full = renderToStaticMarkup(createElement(Spyglass, { data }));
  const bare = renderToStaticMarkup(
    createElement(Spyglass, { data, mapOnly: true })
  );
  expect(full).toContain("spyglass-shell");
  expect(full).toContain('aria-label="Interactive spyglass"');
  expect(full).toContain('aria-label="Spyglass controls"');
  expect(bare).toContain('aria-label="Interactive spyglass"');
  expect(bare).not.toContain("spyglass-shell");
  expect(bare).not.toContain('aria-label="Spyglass controls"');
});
