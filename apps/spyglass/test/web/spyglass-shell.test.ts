// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachPointer } from "../../src/web/interaction/pointer";
import { createSpyglassScene } from "../../src/web/scene/scene";
import Spyglass from "../../src/web/ui/spyglass-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

vi.mock("../../src/web/interaction/pointer", () => ({
  attachPointer: vi.fn(() => ({ detach: vi.fn() })),
}));
vi.mock("../../src/web/scene/scene", () => ({
  createSpyglassScene: vi.fn((host: HTMLElement) => {
    const canvas = document.createElement("canvas");
    host.append(canvas);
    return {
      apply: vi.fn(),
      canvas,
      captureView: vi.fn(() => ({ pixels: 2, x: 10, y: 20 })),
      describe: vi.fn(() => []),
      dispose: vi.fn(() => canvas.remove()),
      focus: vi.fn(),
      focusWreck: vi.fn(),
      getRenderStatus: vi.fn(() => ({
        adapted: false,
        backend: "webgl" as const,
        failure: null,
        frameMs: null,
        globalIlluminationAvailable: false,
        postProcessing: true,
        quality: "medium" as const,
      })),
      restoreView: vi.fn(),
      zoom: vi.fn(),
    };
  }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true,
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: vi.fn().mockResolvedValue([]) },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    })),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

async function mount() {
  const data = await loadSpyglass();
  await act(async () => {
    root.render(createElement(Spyglass, { data }));
  });
}
function button(name: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")]
    .filter(
      (element) => !element.closest("dialog") || element.closest("dialog")?.open
    )
    .find(
      (element) =>
        element.getAttribute("aria-label") === name ||
        element.textContent === name
    );
  if (!result) {
    throw new Error(`Missing ${name}`);
  }
  return result;
}
it("starts with the map, compass control and three labelled bottom bar buttons", async () => {
  await mount();
  expect(container.querySelector("canvas")).not.toBeNull();
  expect(
    [...container.querySelectorAll(".spyglass-bottom-bar button")].map(
      (element) => element.getAttribute("aria-label")
    )
  ).toEqual(["Spyglass", "Show files", "Legend"]);
  expect(button("Legend").textContent).toBe("Legend");
  expect(button("Legend").querySelector("svg")).not.toBeNull();
  expect(
    container.querySelector<HTMLDialogElement>("#spyglass-sheet")?.open
  ).toBe(false);
  expect(container.textContent).not.toContain("Find a place");
  expect(container.querySelector(".spyglass-panel")).toBeNull();
  expect(container.querySelector(".spyglass-legend")).toBeNull();
});
it("opens the legend in a modal sheet and restores trigger focus on close", async () => {
  await mount();
  const trigger = button("Legend");
  trigger.focus();
  await act(() => trigger.click());
  expect(
    container.querySelector<HTMLDialogElement>("#spyglass-sheet")?.open
  ).toBe(true);
  expect(container.querySelector("#spyglass-sheet h1")?.textContent).toBe(
    "Legend"
  );
  expect(trigger.textContent).toBe("Legend");
  expect(container.querySelector('[aria-label="Map legend"]')).not.toBeNull();
  const details = container.querySelector<HTMLElement>(
    ".spyglass-map-key summary"
  );
  if (!details) {
    throw new Error("Missing enabled map details");
  }
  details.focus();
  await act(() =>
    details.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
      })
    )
  );
  expect(document.activeElement).toBe(
    button("Close sheet; drag down to dismiss")
  );
  await act(() => button("Close").click());
  expect(
    container.querySelector<HTMLDialogElement>("#spyglass-sheet")?.open
  ).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(trigger.textContent).toBe("Legend");
});
it("dismisses the Spyglass sheet on native Escape cancellation", async () => {
  await mount();
  await act(() => button("Spyglass").click());
  expect(container.querySelector("#spyglass-sheet h1")?.textContent).toBe(
    "Spyglass"
  );
  await act(() =>
    container
      .querySelector<HTMLDialogElement>("#spyglass-sheet")
      ?.dispatchEvent(new Event("cancel", { cancelable: true }))
  );
  expect(
    container.querySelector<HTMLDialogElement>("#spyglass-sheet")?.open
  ).toBe(false);
});
it("exposes reader layers and camera controls without rebuilding the map when sheets open", async () => {
  await mount();
  const count = vi.mocked(createSpyglassScene).mock.calls.length;
  await act(() => button("Open chart controls").click());
  expect(container.textContent).toContain("Sea trade routes");
  const scene = await vi.mocked(createSpyglassScene).mock.results.at(-1)?.value;
  await act(() => button("Zoom in").click());
  expect(scene.zoom).toHaveBeenCalledWith(1.35);
  await act(() => button("Whole spyglass").click());
  expect(scene.focus).toHaveBeenCalledWith(null);
  const control = container.querySelector<HTMLInputElement>(
    'input[name="trade"]'
  );
  expect(control).not.toBeNull();
  await act(() => control?.click());
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      chartSettings: expect.objectContaining({ trade: true }),
    })
  );
  expect(vi.mocked(createSpyglassScene).mock.calls.length).toBe(count);
});
it("separates atmosphere from measured map layers and applies a toggle", async () => {
  await mount();
  await act(() => button("Open chart controls").click());
  expect(container.querySelector('input[name="waves"]')).toBeNull();
  await act(() => button("Rendering").click());
  expect(container.textContent).toContain("Atmosphere");
  const scene = await vi.mocked(createSpyglassScene).mock.results.at(-1)?.value;
  const labels = [...container.querySelectorAll(".spyglass-layer-control")].map(
    (element) => element.textContent
  );
  expect(labels).toEqual(["Water motion", "Foundation light"]);
  const waves = container.querySelector<HTMLInputElement>(
    'input[name="waves"]'
  );
  const clouds = container.querySelector<HTMLInputElement>(
    'input[name="clouds"]'
  );
  expect(waves?.checked).toBe(true);
  expect(clouds?.checked).toBe(true);
  await act(() => clouds?.click());
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      chartSettings: expect.objectContaining({ clouds: false, waves: true }),
    })
  );
});
it("writes a click's place to the snapshot's selection, and Escape clears it", async () => {
  const data = await loadSpyglass();
  const territory = data.territories.find((item) => item.files.length > 0);
  const file = territory?.files[0];
  if (!(territory && file)) {
    throw new Error("The fixture has no island with files.");
  }
  await act(async () => {
    root.render(createElement(Spyglass, { data }));
  });
  const scene = await vi.mocked(createSpyglassScene).mock.results.at(-1)?.value;
  const callbacks = vi.mocked(attachPointer).mock.calls.at(-1)?.[1];
  if (!callbacks) {
    throw new Error("The pointer was not attached");
  }
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({ selection: null })
  );
  // A click, or a label's activation, reaches the scene as ids on the snapshot.
  await act(() => callbacks.onSelect({ file, territory }));
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      selection: { fileId: file.id, territoryId: territory.id },
    })
  );
  await act(() => callbacks.onSelect({ territory }));
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({ selection: { territoryId: territory.id } })
  );
  // Escape clears it through the same snapshot and, as Whole spyglass does,
  // sends the camera home at once, so Escape with nothing selected still
  // returns to the overview.
  await act(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  );
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({ selection: null })
  );
  expect(scene.focus).toHaveBeenCalledWith(null);
});
it("lets the selection go and flies to the overview on Whole spyglass", async () => {
  const data = await loadSpyglass();
  const [territory] = data.territories;
  if (!territory) {
    throw new Error("The fixture has no island.");
  }
  await act(async () => {
    root.render(createElement(Spyglass, { data }));
  });
  const scene = await vi.mocked(createSpyglassScene).mock.results.at(-1)?.value;
  const callbacks = vi.mocked(attachPointer).mock.calls.at(-1)?.[1];
  await act(() => callbacks?.onSelect({ territory }));
  await act(() => button("Open chart controls").click());
  await act(() => button("Whole spyglass").click());
  expect(scene.focus).toHaveBeenCalledWith(null);
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({ selection: null })
  );
});

it("lets the handle dismiss, snaps back on a short drag, and cancels safely", async () => {
  await mount();
  const trigger = button("Legend");
  await act(() => trigger.click());
  const handle = button("Close sheet; drag down to dismiss");
  const sheet = handle.closest("dialog");
  Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
  Object.defineProperty(sheet, "clientHeight", { value: 400 });
  const pointer = async (type: string, y: number) => {
    await act(() =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientY: y,
          isPrimary: true,
          pointerId: 1,
        })
      )
    );
  };
  await pointer("pointerdown", 100);
  await pointer("pointermove", 130);
  expect(sheet?.style.translate).toBe("0 30px");
  await pointer("pointerup", 130);
  expect(sheet?.open).toBe(true);
  expect(sheet?.style.translate).toBe("");
  await pointer("pointerdown", 100);
  await pointer("pointermove", 220);
  await pointer("pointercancel", 220);
  expect(sheet?.open).toBe(true);
  expect(sheet?.style.translate).toBe("");
  await pointer("pointerdown", 100);
  await pointer("pointermove", 220);
  await pointer("pointerup", 220);
  expect(sheet?.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  await act(() => trigger.click());
  await act(() => handle.click());
  expect(sheet?.open).toBe(false);
});

it("opens settings only from the compass and restores trigger focus", async () => {
  await mount();
  const compass = button("Open chart controls");
  const sidebar =
    container.querySelector<HTMLDialogElement>("#spyglass-sidebar");
  expect(
    container.querySelector(
      '.spyglass-bottom-bar [aria-controls="spyglass-sidebar"]'
    )
  ).toBeNull();
  expect(
    container.querySelector(".spyglass-bottom-bar")?.textContent
  ).not.toContain("Rendering");
  await act(() => compass.click());
  expect(sidebar?.open).toBe(true);
  expect(sidebar?.textContent).toContain("Measured layers");
  await act(() => button("Close chart controls").click());
  expect(sidebar?.open).toBe(false);
  expect(document.activeElement).toBe(compass);
});

it("separates navigation in the top bar from reading mode in the bottom bar", async () => {
  await mount();
  const bar = container.querySelector('[aria-label="Map controls"]');
  expect(button("Zoom in").closest("nav")).toBe(bar);
  expect(button("Zoom out").closest("nav")).toBe(bar);
  expect(button("Whole spyglass").closest("nav")).toBe(bar);
  const scene = await vi.mocked(createSpyglassScene).mock.results.at(-1)?.value;
  await act(() => button("Zoom out").click());
  expect(scene.zoom).toHaveBeenCalledWith(1 / 1.35);
  expect(button("Show files").closest("nav")).toBe(
    container.querySelector(".spyglass-bottom-bar")
  );
  await act(() => button("Show files").click());
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({ mapLayer: "files" })
  );
  await act(() => button("Show belonging").click());
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({ mapLayer: "belonging" })
  );
  expect(
    container.querySelector<HTMLDialogElement>("#spyglass-sidebar")?.open
  ).toBe(false);
});

it("keeps the app bar active while the modeless settings panel is open", async () => {
  await mount();
  const sidebar =
    container.querySelector<HTMLDialogElement>("#spyglass-sidebar");
  if (!sidebar) {
    throw new Error("Missing sidebar");
  }
  const show = vi.spyOn(sidebar, "show");
  const showModal = vi.spyOn(sidebar, "showModal");
  await act(() => button("Open chart controls").click());
  expect(show).toHaveBeenCalledOnce();
  expect(showModal).not.toHaveBeenCalled();
  const scene = await vi.mocked(createSpyglassScene).mock.results.at(-1)?.value;
  await act(() => button("Zoom in").click());
  expect(scene.zoom).toHaveBeenCalledWith(1.35);
  expect(sidebar.open).toBe(true);
  await act(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      })
    )
  );
  expect(sidebar.open).toBe(false);
  expect(scene.focus).not.toHaveBeenCalled();
});

it("enables controls opened during scene startup as soon as the renderer is ready", async () => {
  const original = vi.mocked(createSpyglassScene).getMockImplementation();
  if (!original) {
    throw new Error("Missing scene factory");
  }
  let finish: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.mocked(createSpyglassScene).mockImplementationOnce(async (...args) => {
    await ready;
    return original(...args);
  });
  await mount();
  await act(() => button("Open chart controls").click());
  const trade = container.querySelector<HTMLInputElement>(
    'input[name="trade"]'
  );
  expect(trade?.disabled).toBe(true);
  await act(async () => {
    finish();
    await ready;
  });
  expect(trade?.disabled).toBe(false);
  await act(() => trade?.click());
  const scene = await vi.mocked(createSpyglassScene).mock.results.at(-1)?.value;
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      chartSettings: expect.objectContaining({ trade: true }),
    })
  );
});

it("keeps global reset above keyboard-accessible tabs and retains settings across tabs", async () => {
  await mount();
  await act(() => button("Open chart controls").click());
  const sidebar = container.querySelector("#spyglass-sidebar");
  const reset = button("Reset visualization");
  const tabs = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Map",
    "Foundations",
    "Layers",
    "Rendering",
    "Stats",
  ]);
  expect(reset.closest("[role=tabpanel]")).toBeNull();
  expect(sidebar?.querySelector(".spyglass-sidebar-actions button")).toBe(
    reset
  );
  const trade = container.querySelector<HTMLInputElement>(
    'input[name="trade"]'
  );
  await act(() => trade?.click());
  await act(() =>
    tabs[0]?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
    )
  );
  expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tabs[1]);
  await act(() => button("Map").click());
  expect(
    container.querySelector<HTMLInputElement>('input[name="trade"]')?.checked
  ).toBe(true);
  await act(() => button("Rendering").click());
  await act(() => reset.click());
  await act(() => button("Map").click());
  expect(
    container.querySelector<HTMLInputElement>('input[name="trade"]')?.checked
  ).toBe(false);
});

it("changes foundation presentation through the sidebar without rebuilding the scene or moving the camera", async () => {
  const data = await loadSpyglass();
  data.foundations = [
    {
      id: "dependency:zod",
      lobes: [],
      members: data.territories.slice(0, 2).map((territory) => ({
        direct: true,
        distance: 1,
        territoryId: territory.id,
        weight: 1,
      })),
      name: "zod",
      prominence: 2,
      versions: ["4.0.0"],
      x: 0,
      y: 0,
    },
  ];
  data.foundationGroups = [
    {
      dependencyIds: ["dependency:zod"],
      footprint: [],
      id: "group:shared",
      memberIds: data.territories.slice(0, 2).map(({ id }) => id),
    },
  ];
  data.dependencyCoverage = "partial";
  await act(() => root.render(createElement(Spyglass, { data })));
  const count = vi.mocked(createSpyglassScene).mock.calls.length;
  const scene = await vi.mocked(createSpyglassScene).mock.results.at(-1)?.value;
  const canvas = container.querySelector("canvas");
  scene.focus.mockClear();
  scene.restoreView.mockClear();
  await act(() => button("Open chart controls").click());
  await act(() => button("Foundations").click());
  const selector = container.querySelector<HTMLSelectElement>(
    'select[name="foundationFocus"]'
  );
  if (!selector) {
    throw new Error("Missing foundation selector");
  }
  await act(() => {
    selector.value = "dependency:zod";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      chartSettings: expect.objectContaining({
        foundationFocus: "dependency:zod",
      }),
      data,
    })
  );
  await act(() => {
    selector.value = "group:shared";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      chartSettings: expect.objectContaining({
        foundationFocus: "group:shared",
      }),
      data,
    })
  );
  await act(() => button("Isolate foundations").click());
  expect(scene.apply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      chartSettings: expect.objectContaining({
        composition: {
          hidden: [],
          solo: ["sea", "dependency-foundations", "subsurface-drift"],
        },
      }),
    })
  );
  await act(() => button("Restore layers").click());
  expect(vi.mocked(createSpyglassScene).mock.calls).toHaveLength(count);
  expect(container.querySelector("canvas")).toBe(canvas);
  expect(scene.focus).not.toHaveBeenCalled();
  expect(scene.restoreView).not.toHaveBeenCalled();
});
