import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { inkStyle, swatchInk } from "../../src/web/ladder/ink-table";
import { MapKey } from "../../src/web/ui/map-key";
import { createSpyglassState } from "../../src/web/ui/spyglass-state";
import { loadSpyglass } from "../helpers/reference-spyglass";

async function state() {
  return createSpyglassState(await loadSpyglass());
}

it("leads with package, file and dependency meanings and keeps detail collapsed", async () => {
  const html = renderToStaticMarkup(
    createElement(MapKey, { state: await state() })
  );
  expect(html).toContain("Islands are packages.");
  expect(html).toContain("Marks are files.");
  expect(html).toContain("Dependencies run from a consumer");
  expect(html).toContain("<summary>Enabled map details</summary>");
  expect(html).not.toContain("<details open");
  expect(html).not.toContain('data-ink="selection"');
  expect(html).not.toContain('data-ink="trade"');
  expect(html).not.toContain('data-ink="land-contour"');
  expect(html).not.toContain('data-ink="stream"');
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<input");
});

it("explains only the isolated ocean and its enabled effects", async () => {
  const current = await state();
  current.chartSettings.composition = { hidden: [], solo: ["sea"] };
  const html = renderToStaticMarkup(createElement(MapKey, { state: current }));
  expect(html).toContain("isolates the environment");
  expect(html).not.toContain("Islands are packages");
  expect(html).not.toContain("Marks are files");
  expect(html).not.toContain("Enabled map details");
  expect(html).not.toContain("Water shading");
  expect(html).not.toContain("Subsurface drift");
  current.data.foundations = [
    {
      id: "dependency:zod",
      lobes: [],
      members: [],
      name: "zod",
      prominence: 2,
      versions: [],
      x: 0,
      y: 0,
    },
  ];
  current.chartSettings.composition = {
    hidden: [],
    solo: ["sea", "dependency-foundations", "subsurface-drift"],
  };
  expect(
    renderToStaticMarkup(createElement(MapKey, { state: current }))
  ).toContain("Foundation light is decorative");
});

it("requires both reader preference and composition visibility for optional overlays", async () => {
  const current = await state();
  current.chartSettings.trade = true;
  current.chartSettings.contours = true;
  let html = renderToStaticMarkup(createElement(MapKey, { state: current }));
  expect(html).toContain('data-ink="trade"');
  expect(html).toContain('data-ink="land-contour"');
  current.chartSettings.composition = {
    hidden: ["trades", "topography"],
    solo: [],
  };
  html = renderToStaticMarkup(createElement(MapKey, { state: current }));
  expect(html).not.toContain('data-ink="trade"');
  expect(html).not.toContain('data-ink="land-contour"');
});

it("uses the renderer's dash, weight, and ink for selected dependency direction", async () => {
  const current = await state();
  current.selection = {
    territoryId: current.data.territories[0]?.id ?? "package",
  };
  const html = renderToStaticMarkup(createElement(MapKey, { state: current }));
  const style = inkStyle("selection-imports");
  expect(html).toContain(`stroke="${swatchInk(style)}"`);
  expect(html).toContain(`stroke-dasharray="${style.dash.join(" ")}"`);
  expect(html).toContain(`stroke-width="${style.weight}"`);
  expect(html).toContain("Dashed: the selection imports");
  expect(html).toContain("Dotted: this package or file imports the selection");
  expect(html).not.toContain('data-ink="departure-line"');
  current.chartSettings.composition = { hidden: ["selection"], solo: [] };
  expect(
    renderToStaticMarkup(createElement(MapKey, { state: current }))
  ).not.toContain('aria-label="Selection meanings"');
});
