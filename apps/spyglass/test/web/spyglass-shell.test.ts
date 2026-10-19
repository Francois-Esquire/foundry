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
  ).toEqual(["Spyglass", "Legend", "Rendering"]);
  expect(button("Legend").textContent).toBe("Legend");
  expect(button("Rendering").textContent).toBe("Rendering");
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
  expect(button("Rendering").textContent).toBe("Rendering");
  expect(container.querySelector('[aria-label="Map legend"]')).not.toBeNull();
  const dismiss = button("Close");
  dismiss.focus();
  await act(() =>
    dismiss.dispatchEvent(
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
  await act(() => button("Rendering").click());
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
it("offers the weather under the layers, on by default, and applies a toggle", async () => {
  await mount();
  await act(() => button("Rendering").click());
  expect(container.textContent).toContain("Weather");
  const scene = await vi.mocked(createSpyglassScene).mock.results.at(-1)?.value;
  const labels = [...container.querySelectorAll(".spyglass-layer-control")].map(
    (element) => element.textContent
  );
  // Reader layers remain together in the Rendering sheet.
  expect(labels.slice(0, 6)).toEqual([
    "Sea trade routes",
    "District streams",
    "Recorded change",
    "Topographic lines",
    "Rim waves",
    "Cloud shadow",
  ]);
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
  await act(() => button("Rendering").click());
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

it("opens the same sidebar from the compass and Rendering, preserving trigger focus", async () => {
  await mount();
  const compass = button("Open chart controls");
  expect(compass.querySelector("svg")?.getAttribute("viewBox")).toBe(
    "0 0 100 100"
  );
  const sidebar =
    container.querySelector<HTMLDialogElement>("#spyglass-sidebar");
  await act(() => compass.click());
  expect(sidebar?.open).toBe(true);
  expect(sidebar?.textContent).toContain("Layers & atmosphere");
  expect(sidebar?.querySelector('[aria-label="Map navigation"]')).toBeNull();
  await act(() => button("Close chart controls").click());
  expect(sidebar?.open).toBe(false);
  expect(document.activeElement).toBe(compass);
  const rendering = button("Rendering");
  await act(() => rendering.click());
  expect(sidebar?.open).toBe(true);
  expect(
    container.querySelector<HTMLDialogElement>("#spyglass-sheet")?.open
  ).toBe(false);
  await act(() =>
    sidebar?.dispatchEvent(new Event("cancel", { cancelable: true }))
  );
  expect(sidebar?.open).toBe(false);
  expect(document.activeElement).toBe(rendering);
});

it("keeps navigation and map mode available in the app bar with settings closed", async () => {
  await mount();
  const bar = container.querySelector('[aria-label="Map controls"]');
  expect(button("Zoom in").closest("nav")).toBe(bar);
  expect(button("Zoom out").closest("nav")).toBe(bar);
  expect(button("Whole spyglass").closest("nav")).toBe(bar);
  const scene = await vi.mocked(createSpyglassScene).mock.results.at(-1)?.value;
  await act(() => button("Zoom out").click());
  expect(scene.zoom).toHaveBeenCalledWith(1 / 1.35);
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
