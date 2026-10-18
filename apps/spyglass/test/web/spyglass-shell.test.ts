// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  const result = [...container.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name ||
      element.textContent === name
  );
  if (!result) {
    throw new Error(`Missing ${name}`);
  }
  return result;
}
it("starts with only the map and three bottom bar buttons", async () => {
  await mount();
  expect(container.querySelector("canvas")).not.toBeNull();
  expect(
    [...container.querySelectorAll("nav button")].map((element) =>
      element.getAttribute("aria-label")
    )
  ).toEqual(["Spyglass", "Legend", "Rendering"]);
  expect(button("Legend").textContent).toBe("");
  expect(button("Rendering").textContent).toBe("");
  expect(button("Legend").querySelector("svg")).not.toBeNull();
  expect(container.querySelector("dialog")?.open).toBe(false);
  expect(container.textContent).not.toContain("Find a place");
  expect(container.querySelector(".spyglass-panel")).toBeNull();
  expect(container.querySelector(".spyglass-legend")).toBeNull();
});
it("opens the legend in a modal sheet and restores trigger focus on close", async () => {
  await mount();
  const trigger = button("Legend");
  trigger.focus();
  await act(() => trigger.click());
  expect(container.querySelector("dialog")?.open).toBe(true);
  expect(container.querySelector("h1")?.textContent).toBe("Legend");
  expect(trigger.textContent).toBe("Legend");
  expect(button("Rendering").textContent).toBe("");
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
  expect(document.activeElement).toBe(dismiss);
  await act(() => button("Close").click());
  expect(container.querySelector("dialog")?.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(trigger.textContent).toBe("");
});
it("dismisses the Spyglass sheet on native Escape cancellation", async () => {
  await mount();
  await act(() => button("Spyglass").click());
  expect(container.querySelector("h1")?.textContent).toBe("Spyglass");
  await act(() =>
    container
      .querySelector("dialog")
      ?.dispatchEvent(new Event("cancel", { cancelable: true }))
  );
  expect(container.querySelector("dialog")?.open).toBe(false);
});
it("exposes rendering, layers, boundaries and camera controls without rebuilding the map when sheets open", async () => {
  await mount();
  const count = vi.mocked(createSpyglassScene).mock.calls.length;
  await act(() => button("Rendering").click());
  expect(container.textContent).toContain("Layout and boundaries");
  expect(container.textContent).toContain("Sea trade routes");
  expect(container.textContent).toContain("Exposure");
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
