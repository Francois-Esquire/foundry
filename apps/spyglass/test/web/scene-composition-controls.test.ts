// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type DeveloperSettings,
  defaultChartSettings,
} from "../../src/web/settings/chart-settings";
import { DeveloperSettingsSection } from "../../src/web/ui/developer-settings";

let root: Root;
let container: HTMLDivElement;
let settings: DeveloperSettings;
const changed = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  settings = {
    ...defaultChartSettings,
    composition: { hidden: [], solo: [] },
  };
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  changed.mockClear();
});

async function mount(disabled = false) {
  function Harness() {
    const [current, setCurrent] = useState(settings);
    return createElement(DeveloperSettingsSection, {
      disabled,
      layoutPending: false,
      onChange: (next) => {
        settings = next;
        changed(next);
        setCurrent(next);
      },
      scene: { current: null },
      settings: current,
    });
  }
  await act(() => root.render(createElement(Harness)));
}

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (element) =>
      (element.getAttribute("aria-label") ?? element.textContent) === label
  );
  if (!match) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

function checkbox(label: string) {
  const match = container.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  );
  if (!match) {
    throw new Error(`Missing checkbox: ${label}`);
  }
  return match;
}

it("isolates a clean or complete ocean and restores hidden choices without changing generation or rendering", async () => {
  await mount();
  const { layers: generation, rendering, boundaries } = settings;
  await act(() => checkbox("Show: Files").click());
  await act(() => checkbox("Show: Foundation light").click());
  expect(settings.composition.hidden).toEqual(["files", "subsurface-drift"]);

  await act(() => button("Ocean").click());
  expect(settings.composition).toEqual({
    hidden: ["files", "subsurface-drift"],
    solo: [
      "sea",
      "ocean-depth",
      "ocean-shallows",
      "dependency-foundations",
      "subsurface-drift",
      "rim-surf",
      "surface-motion",
    ],
  });
  expect(button("Ocean").getAttribute("aria-pressed")).toBe("true");
  expect(checkbox("Include in solo: Foundation light").checked).toBe(true);

  await act(() => button("Clean ocean").click());
  expect(settings.composition.solo).toEqual(["sea"]);
  expect(button("Ocean").getAttribute("aria-pressed")).toBe("false");
  expect(button("Clean ocean").getAttribute("aria-pressed")).toBe("true");
  const selected = [
    ...container.querySelectorAll<HTMLInputElement>(
      ".spyglass-scene-visibility input:checked"
    ),
  ];
  expect(selected).toHaveLength(1);
  expect(selected[0]?.getAttribute("aria-label")).toBe(
    "Include in solo: Ocean"
  );
  expect(checkbox("Include in solo: Ocean").disabled).toBe(true);
  expect(checkbox("Include in solo: Island surfaces").checked).toBe(false);

  await act(() => button("Restore previous view").click());
  expect(settings.composition).toEqual({
    hidden: ["files", "subsurface-drift"],
    solo: [],
  });
  expect(checkbox("Show: Files").checked).toBe(false);
  expect(checkbox("Show: Foundation light").checked).toBe(false);
  expect(checkbox("Show: Island surfaces").checked).toBe(true);
  expect(settings.layers).toBe(generation);
  expect(settings.rendering).toBe(rendering);
  expect(settings.boundaries).toBe(boundaries);
  expect(settings.islandClearance).toBe(defaultChartSettings.islandClearance);
});

it("adds and removes isolated layers while preserving the view to restore", async () => {
  settings.composition = { hidden: ["labels"], solo: [] };
  await mount();
  await act(() => button("Solo Ocean").click());
  await act(() => checkbox("Include in solo: Island surfaces").click());
  expect(settings.composition.solo).toEqual(["sea", "relief"]);
  await act(() => checkbox("Include in solo: Ocean").click());
  expect(settings.composition.solo).toEqual(["relief"]);
  expect(checkbox("Include in solo: Island surfaces").disabled).toBe(true);

  await act(() => button("Terrain").click());
  expect(checkbox("Include in solo: Ocean").checked).toBe(true);
  expect(checkbox("Include in solo: Coastal cliffs").checked).toBe(true);
  expect(checkbox("Include in solo: Depth shading").checked).toBe(true);
  expect(checkbox("Include in solo: Shallows").checked).toBe(true);
  expect(checkbox("Include in solo: Foundation light").checked).toBe(true);
  expect(checkbox("Include in solo: Rim surf").checked).toBe(true);
  expect(checkbox("Include in solo: Files").checked).toBe(false);
  await act(() => button("Annotated map").click());
  expect(checkbox("Include in solo: Map labels").checked).toBe(true);
  await act(() => button("Restore previous view").click());
  expect(checkbox("Show: Map labels").checked).toBe(false);
});

it("solos each effect with an ocean surface and reflects the exact selected combination", async () => {
  settings.composition = { hidden: ["sea", "subsurface-drift"], solo: [] };
  await mount();
  const effects = [
    ["Depth shading", "ocean-depth"],
    ["Shallows", "ocean-shallows"],
    ["Dependency foundations", "dependency-foundations"],
    ["Foundation light", "subsurface-drift"],
    ["Rim surf", "rim-surf"],
  ] as const;
  for (const [label, id] of effects) {
    await act(() => button(`Solo ${label}`).click());
    expect(settings.composition.solo).toEqual(
      id === "subsurface-drift"
        ? ["sea", "dependency-foundations", "subsurface-drift"]
        : ["sea", id]
    );
    expect(checkbox("Include in solo: Ocean").checked).toBe(true);
    expect(button(`Solo ${label}`).getAttribute("aria-pressed")).toBe("true");
    expect(button("Solo Ocean").getAttribute("aria-pressed")).toBe("false");
    await act(() => checkbox("Include in solo: Island surfaces").click());
    expect(button(`Solo ${label}`).getAttribute("aria-pressed")).toBe("false");
  }
  await act(() => button("Restore previous view").click());
  expect(settings.composition).toEqual({
    hidden: ["sea", "subsurface-drift"],
    solo: [],
  });
});

it("shows all layers explicitly and disables restoration outside solo", async () => {
  settings.composition = { hidden: ["files", "relief"], solo: ["sea"] };
  await mount();
  await act(() => button("Show all").click());
  expect(settings.composition).toEqual({ hidden: [], solo: [] });
  expect(button("Restore previous view").disabled).toBe(true);
  expect(
    [
      ...container.querySelectorAll<HTMLInputElement>(
        ".spyglass-scene-visibility input"
      ),
    ].every((input) => input.checked)
  ).toBe(true);
});

it("keeps every isolation control unavailable before the scene is ready", async () => {
  await mount(true);
  for (const control of container.querySelectorAll(
    ".spyglass-scene-visibility button, .spyglass-scene-visibility input"
  )) {
    expect(control.closest("fieldset[disabled]")).not.toBeNull();
  }
  expect(changed).not.toHaveBeenCalled();
});
