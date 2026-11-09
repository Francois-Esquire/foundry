// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createIslands } from "../../src/web/islands/gpu/islands/api/islands";
import Spyglass from "../../src/web/ui/spyglass-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** The Islands the map opened, as the fake below records it. */
const fake = vi.hoisted(() => {
  type Listener = (value: unknown) => void;
  const make = () => {
    const listeners = new Map<string, Set<Listener>>();
    return {
      dispose: vi.fn(),
      /** Sends an Islands event to the map's listeners. */
      emit: (event: string, value: unknown) => {
        for (const listener of listeners.get(event) ?? []) {
          listener(value);
        }
      },
      fit: vi.fn(),
      frame: vi.fn(),
      heightAt: vi.fn(() => 0),
      on: vi.fn((event: string, listener: Listener) => {
        const set = listeners.get(event) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(event, set);
        return () => set.delete(listener);
      }),
      pixelsPerUnit: vi.fn(() => 2),
      project: vi.fn(() => ({ visible: true, x: 0, y: 0 })),
      select: vi.fn(),
      setChart: vi.fn(),
      setControls: vi.fn(),
      setSettings: vi.fn(),
      setView: vi.fn(),
      view: {
        distance: 1000,
        pitch: 1,
        target: [0, 0, 0] as [number, number, number],
        yaw: 0,
      },
    };
  };
  const instances: ReturnType<typeof make>[] = [];
  return {
    create: () => {
      const opened = make();
      instances.push(opened);
      return opened;
    },
    instances,
  };
});

// The engine behind `<IslandsCanvas>`, inside the synced copy.
vi.mock("../../src/web/islands/gpu/islands/api/islands", () => ({
  createIslands: vi.fn(() => fake.create()),
  DEFAULT_ISLANDS_SETTINGS: { selection: false, waveAmplitude: 1 },
}));
vi.mock("../../src/web/islands-host/chart", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/web/islands-host/chart")
  >()),
  loadIslandsChart: vi.fn(async () => ({
    chart: { foundations: [], islands: [], modules: [] },
    notes: [],
  })),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  fake.instances.length = 0;
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

/** The Islands the map last opened. */
function islands() {
  const opened = fake.instances.at(-1);
  if (!opened) {
    throw new Error("The map opened no Islands");
  }
  return opened;
}

/** Islands draws a frame: the first makes the map ready. */
async function drawFrame() {
  await act(() => islands().emit("frame", { cpuMs: 1 }));
}

/** Mounts the viewer and, unless told not to, lets Islands draw its first frame. */
async function mount(options: { ready?: boolean } = {}) {
  const data = await loadSpyglass();
  await act(async () => {
    root.render(createElement(Spyglass, { data }));
  });
  if (options.ready !== false) {
    await drawFrame();
  }
  return data;
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
it("starts with the map, compass control and two labelled bottom bar buttons", async () => {
  await mount();
  expect(container.querySelector("canvas")).not.toBeNull();
  expect(
    [...container.querySelectorAll(".spyglass-bottom-bar button")].map(
      (element) => element.getAttribute("aria-label")
    )
  ).toEqual(["Spyglass", "Legend"]);
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
  const close = button("Close sheet");
  close.focus();
  await act(() =>
    close.dispatchEvent(
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
  await act(() => button("Close sheet").click());
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
it("zooms and frames the whole spyglass without rebuilding the map when the controls open", async () => {
  await mount();
  const count = vi.mocked(createIslands).mock.calls.length;
  await act(() => button("Open chart controls").click());
  const map = islands();
  await act(() => button("Zoom in").click());
  expect(map.setView).toHaveBeenLastCalledWith(
    expect.objectContaining({ distance: 1000 / 1.35 })
  );
  await act(() => button("Whole spyglass").click());
  expect(map.frame).toHaveBeenCalledWith(null);
  expect(vi.mocked(createIslands).mock.calls.length).toBe(count);
});
it("turns the waves off through Islands' settings in the Rendering section", async () => {
  await mount();
  await act(() => button("Open chart controls").click());
  await act(() => button("Rendering").click());
  expect(container.textContent).toContain("Atmosphere");
  const labels = [...container.querySelectorAll(".spyglass-layer-control")].map(
    (element) => element.textContent
  );
  expect(labels).toEqual(["Water motion"]);
  const waves = container.querySelector<HTMLInputElement>(
    'input[name="waves"]'
  );
  expect(waves?.checked).toBe(true);
  await act(() => waves?.click());
  expect(waves?.checked).toBe(false);
  expect(islands().setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ waveAmplitude: 0 })
  );
  await act(() => waves?.click());
  expect(islands().setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ waveAmplitude: 1 })
  );
});
it("sets the camera angle in the Rendering section without rebuilding the map", async () => {
  await mount();
  const map = islands();
  const count = vi.mocked(createIslands).mock.calls.length;
  await act(() => button("Open chart controls").click());
  await act(() => button("Rendering").click());
  const angle = container.querySelector<HTMLSelectElement>(
    'select[name="angle"]'
  );
  expect([...(angle?.options ?? [])].map((option) => option.text)).toEqual([
    "Top-down (90°)",
    "Chart (50°)",
    "Isometric (55°)",
  ]);
  expect(angle?.value).toBe("chart");
  await act(() => {
    if (angle) {
      angle.value = "top-down";
      angle.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  expect(map.setView).toHaveBeenLastCalledWith(
    expect.objectContaining({ pitch: Math.PI / 2 })
  );
  const elevation = container.querySelector<HTMLInputElement>(
    'input[name="elevation"]'
  );
  await act(() => {
    if (elevation) {
      // React tracks the value it last set; the prototype's setter goes past it.
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(elevation, "70");
      elevation.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  expect(map.setView).toHaveBeenLastCalledWith(
    expect.objectContaining({ pitch: (70 * Math.PI) / 180 })
  );
  expect(angle?.value).toBe("custom");
  expect(vi.mocked(createIslands).mock.calls.length).toBe(count);
});
it("writes what Islands chose to the snapshot's selection, and Escape clears it", async () => {
  const data = await mount();
  const territory = data.territories.find((item) => item.files.length > 0);
  const file = territory?.files[0];
  if (!(territory && file)) {
    throw new Error("The fixture has no island with files.");
  }
  const map = islands();
  expect(map.select).toHaveBeenLastCalledWith(null);
  // A click in Islands reaches the snapshot, which shows it back in Islands.
  await act(() =>
    map.emit("select", {
      id: file.id,
      islands: [territory.id],
      kind: "module",
      name: file.id,
    })
  );
  expect(map.select).toHaveBeenLastCalledWith(file.id);
  await act(() =>
    map.emit("select", {
      id: territory.id,
      islands: [territory.id],
      kind: "island",
      name: territory.id,
    })
  );
  expect(map.select).toHaveBeenLastCalledWith(territory.id);
  expect(map.frame).toHaveBeenLastCalledWith(territory.id);
  // Escape lets it go and, as Whole spyglass does, sends the camera home.
  await act(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  );
  expect(map.select).toHaveBeenLastCalledWith(null);
  expect(map.frame).toHaveBeenLastCalledWith(null);
});
it("lets the selection go and frames the overview on Whole spyglass", async () => {
  const data = await mount();
  const [territory] = data.territories;
  if (!territory) {
    throw new Error("The fixture has no island.");
  }
  const map = islands();
  await act(() =>
    map.emit("select", {
      id: territory.id,
      islands: [territory.id],
      kind: "island",
      name: territory.id,
    })
  );
  expect(map.select).toHaveBeenLastCalledWith(territory.id);
  await act(() => button("Open chart controls").click());
  await act(() => button("Whole spyglass").click());
  expect(map.frame).toHaveBeenLastCalledWith(null);
  expect(map.select).toHaveBeenLastCalledWith(null);
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
  expect(sidebar?.textContent).toContain("Camera angle");
  await act(() => button("Close chart controls").click());
  expect(sidebar?.open).toBe(false);
  expect(document.activeElement).toBe(compass);
});

it("keeps navigation and the detail toggles in the top bar", async () => {
  await mount();
  const bar = container.querySelector('[aria-label="Map controls"]');
  expect(button("Zoom in").closest("nav")).toBe(bar);
  expect(button("Zoom out").closest("nav")).toBe(bar);
  expect(button("Whole spyglass").closest("nav")).toBe(bar);
  expect(
    [...container.querySelectorAll('[aria-label="Map details"] button')].map(
      (element) => element.textContent
    )
  ).toEqual(["Labels", "Ruler"]);
  await act(() => button("Zoom out").click());
  expect(islands().setView).toHaveBeenLastCalledWith(
    expect.objectContaining({ distance: 1000 * 1.35 })
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
  const map = islands();
  await act(() => button("Zoom in").click());
  expect(map.setView).toHaveBeenCalledWith(
    expect.objectContaining({ distance: 1000 / 1.35 })
  );
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
  expect(map.frame).not.toHaveBeenCalled();
});

it("enables controls opened during startup as soon as Islands draws its first frame", async () => {
  await mount({ ready: false });
  await act(() => button("Open chart controls").click());
  const waves = container.querySelector<HTMLInputElement>(
    'input[name="waves"]'
  );
  expect(waves?.disabled).toBe(true);
  expect(button("Zoom in").closest("fieldset")?.disabled).toBe(true);
  await drawFrame();
  expect(waves?.disabled).toBe(false);
  expect(button("Zoom in").closest("fieldset")?.disabled).toBe(false);
  await act(() => waves?.click());
  expect(islands().setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ waveAmplitude: 0 })
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
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Rendering", "Stats"]);
  expect(reset.closest("[role=tabpanel]")).toBeNull();
  expect(sidebar?.querySelector(".spyglass-sidebar-actions button")).toBe(
    reset
  );
  const waves = () =>
    container.querySelector<HTMLInputElement>('input[name="waves"]');
  await act(() => waves()?.click());
  await act(() =>
    tabs[0]?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
    )
  );
  expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tabs[1]);
  await act(() => button("Rendering").click());
  expect(waves()?.checked).toBe(false);
  await act(() => reset.click());
  expect(waves()?.checked).toBe(true);
});
