// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpyglassData } from "../../src/web/data/types";
import { loadIslandsChart } from "../../src/web/islands-host/chart";
import { createIslands } from "../../src/web/islands-host/islands-api";
import { pitchOf } from "../../src/web/islands-host/map-view";
import { cameraAngles } from "../../src/web/settings/chart-settings";
import { releaseFirstFrame } from "../../src/web/timings";
import { IslandsMap } from "../../src/web/ui/islands-map";
import {
  createSpyglassState,
  type SpyglassState,
} from "../../src/web/ui/spyglass-state";
import type { MapHandle } from "../../src/web/view/map-contract";
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

vi.mock("../../src/web/islands-host/islands-api", () => ({
  createIslands: vi.fn(() => fake.create()),
  DEFAULT_ISLANDS_SETTINGS: { selection: false, waveAmplitude: 1 },
}));
vi.mock("../../src/web/timings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/web/timings")>()),
  releaseFirstFrame: vi.fn(),
}));
vi.mock("../../src/web/islands-host/chart", () => ({
  loadIslandsChart: vi.fn(async () => ({
    chart: { foundations: [], groups: [], islands: [], modules: [] },
    notes: [],
  })),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  fake.instances.length = 0;
  performance.clearMeasures();
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

/** Islands' first stats, which come once it has fitted the chart: the map settles on them. */
const settle = () => act(() => islands().emit("stats", { buildMs: null }));

/**
 * Mounts the map on the reference spyglass, with spies for what it tells
 * its host, and settles it unless asked not to.
 */
async function mount(
  options: {
    data?: SpyglassData;
    developer?: boolean;
    selection?: SpyglassState["selection"];
    settled?: boolean;
  } = {}
) {
  const data = options.data ?? (await loadSpyglass());
  const state = {
    ...createSpyglassState(data, options.developer ?? false),
    selection: options.selection ?? null,
  };
  const props = {
    mapRef: { current: null as MapHandle | null },
    onEscape: vi.fn(),
    onReadyChange: vi.fn(),
    onSelect: vi.fn(),
    state,
  };
  await act(async () => {
    root.render(createElement(IslandsMap, props));
  });
  if (options.settled !== false && fake.instances.length > 0) {
    await settle();
  }
  /** Renders the map again with the host's state changed. */
  const update = (next: Partial<SpyglassState>) =>
    act(async () => {
      props.state = { ...props.state, ...next };
      root.render(createElement(IslandsMap, { ...props }));
    });
  return { ...props, data, update };
}

const ringOf = (data: SpyglassData) => ({
  id: "ring:0",
  islands: data.territories.slice(0, 2).map((territory) => territory.id),
  kind: "ring",
  name: "a ring",
});

const status = () =>
  container.querySelector('[role="status"]')?.textContent ?? null;

/** The reference spyglass's first island with files, and its first file. */
function islandWithFile(data: SpyglassData) {
  const territory = data.territories.find((item) => item.files.length > 0);
  const file = territory?.files[0];
  if (!(territory && file)) {
    throw new Error("The fixture has no island with files.");
  }
  return { file, territory };
}

it("is ready on Islands' first frame, clears its status and times the submit in a developer session", async () => {
  const { onReadyChange } = await mount({ developer: true });
  expect(onReadyChange).toHaveBeenLastCalledWith(false);
  expect(status()).toContain("Unfolding");
  await act(() => islands().emit("frame", { cpuMs: 1 }));
  expect(onReadyChange).toHaveBeenLastCalledWith(true);
  expect(status()).toBeNull();
  expect(
    performance
      .getEntriesByType("measure")
      .map((entry) => entry.name)
      .filter((name) => name === "spyglass:render-submit")
  ).toHaveLength(1);
  // Later frames do not announce readiness again.
  await act(() => islands().emit("frame", { cpuMs: 1 }));
  expect(onReadyChange.mock.calls.filter(([ready]) => ready)).toHaveLength(1);
});

it("times nothing in a reader's session", async () => {
  await mount();
  await act(() => islands().emit("frame", { cpuMs: 1 }));
  expect(
    performance
      .getEntriesByType("measure")
      .filter((entry) => entry.name.startsWith("spyglass:"))
  ).toEqual([]);
});

it("passes on what Islands chose, but not the echo of the snapshot's own selection", async () => {
  const data = await loadSpyglass();
  const [first, second] = data.territories;
  if (!(first && second)) {
    throw new Error("The fixture has fewer than two islands.");
  }
  const { onSelect } = await mount({
    data,
    selection: { territoryId: first.id },
  });
  expect(islands().select).toHaveBeenLastCalledWith(first.id);
  const island = (id: string) => ({
    id,
    islands: [id],
    kind: "island",
    name: id,
  });
  await act(() => islands().emit("select", island(first.id)));
  expect(onSelect).not.toHaveBeenCalled();
  await act(() => islands().emit("select", island(second.id)));
  expect(onSelect).toHaveBeenLastCalledWith({ territory: second });
  await act(() => islands().emit("select", null));
  expect(onSelect).toHaveBeenLastCalledWith(null);
});

it("passes on a module Islands chose as its file on its island", async () => {
  const data = await loadSpyglass();
  const { file, territory } = islandWithFile(data);
  const { onSelect } = await mount({ data });
  await act(() =>
    islands().emit("select", {
      id: file.id,
      islands: [territory.id],
      kind: "module",
      name: file.id,
    })
  );
  expect(onSelect).toHaveBeenLastCalledWith({ file, territory });
});

it("tells a browser without WebGPU so, and shows any other failure as it came", async () => {
  await mount();
  await act(() =>
    islands().emit("error", { error: new Error("none"), kind: "unsupported" })
  );
  expect(status()).toContain("WebGPU");
  await act(() =>
    islands().emit("error", { error: new Error("boom"), kind: "runtime" })
  );
  expect(status()).toBe("boom");
});

it("frames, focuses and zooms Islands through the map handle", async () => {
  const data = await loadSpyglass();
  const { file, territory } = islandWithFile(data);
  const { mapRef } = await mount({ data });
  const handle = mapRef.current;
  if (!handle) {
    throw new Error("The map filled no handle");
  }
  handle.focus(null);
  expect(islands().frame).toHaveBeenLastCalledWith(null);
  handle.focus({ territoryId: territory.id });
  expect(islands().frame).toHaveBeenLastCalledWith(territory.id);
  handle.focus({ fileId: file.id, territoryId: territory.id });
  expect(islands().frame).toHaveBeenLastCalledWith(file.id);
  handle.zoom(2);
  expect(islands().setView).toHaveBeenLastCalledWith(
    expect.objectContaining({ distance: 500 })
  );
});

it("opens Islands north-up with its keys on the canvas, and closes it on unmount", async () => {
  const { mapRef } = await mount();
  expect(createIslands).toHaveBeenCalledOnce();
  expect(createIslands).toHaveBeenCalledWith(
    container.querySelector("canvas"),
    expect.objectContaining({
      controls: expect.objectContaining({ keyboard: "canvas", turn: false }),
    })
  );
  const map = islands();
  await act(() => root.unmount());
  expect(map.dispose).toHaveBeenCalledOnce();
  expect(mapRef.current).toBeNull();
  root = createRoot(container);
});

it("hands a window Escape to the host unless a dialog is open", async () => {
  const { onEscape } = await mount();
  await act(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  );
  expect(onEscape).toHaveBeenCalledOnce();
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.append(dialog);
  await act(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  );
  dialog.remove();
  expect(onEscape).toHaveBeenCalledOnce();
});

it("loads the chart from the frame's dataset and the map its territories were laid out from", async () => {
  const data = await loadSpyglass();
  const [frame] = data.frames;
  if (!frame) {
    throw new Error("The fixture has no frame.");
  }
  const visualization = { marker: "laid out" } as unknown as NonNullable<
    typeof frame.visualization
  >;
  frame.visualization = visualization;
  await mount({ data });
  expect(loadIslandsChart).toHaveBeenCalledWith(
    expect.objectContaining({ dataset: frame.dataset, visualization })
  );
});

it("clears the host's selection for a ring, and leaves Islands holding the ring", async () => {
  const data = await loadSpyglass();
  const [first] = data.territories;
  if (!first) {
    throw new Error("The fixture has no island.");
  }
  const { onSelect, update } = await mount({
    data,
    selection: { territoryId: first.id },
  });
  islands().select.mockClear();
  await act(() => islands().emit("select", ringOf(data)));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(null);
  // The host clears its selection as asked: the ring stays chosen.
  await update({ selection: null });
  expect(islands().select).not.toHaveBeenCalled();
});

it("keeps a ring chosen with nothing selected, and asks the host for nothing", async () => {
  const data = await loadSpyglass();
  const { onSelect, update } = await mount({ data });
  islands().select.mockClear();
  await act(() => islands().emit("select", ringOf(data)));
  expect(onSelect).not.toHaveBeenCalled();
  await update({ legendHeight: 1 });
  expect(islands().select).not.toHaveBeenCalled();
});

it("lets the host's selection win over a ring, and Escape let the ring go", async () => {
  const data = await loadSpyglass();
  const [first] = data.territories;
  if (!first) {
    throw new Error("The fixture has no island.");
  }
  const { onEscape, update } = await mount({ data });
  await act(() => islands().emit("select", ringOf(data)));
  await update({ selection: { territoryId: first.id } });
  expect(islands().select).toHaveBeenLastCalledWith(first.id);
  // The island chosen in turn is the host's own, so a later ring is held again.
  await act(() =>
    islands().emit("select", {
      id: first.id,
      islands: [first.id],
      kind: "island",
      name: first.id,
    })
  );
  await act(() => islands().emit("select", ringOf(data)));
  await update({ selection: null });
  islands().select.mockClear();
  await act(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  );
  expect(islands().select).toHaveBeenCalledExactlyOnceWith(null);
  expect(onEscape).toHaveBeenCalledOnce();
});

it("shows the snapshot's selection only once Islands has placed its camera", async () => {
  const data = await loadSpyglass();
  const { file, territory } = islandWithFile(data);
  await mount({
    data,
    selection: { fileId: file.id, territoryId: territory.id },
    settled: false,
  });
  expect(islands().select).not.toHaveBeenCalled();
  await settle();
  expect(islands().select).toHaveBeenCalledExactlyOnceWith(file.id);
});

it("stands the camera at the reader's elevation once Islands fits the chart, and on every change", async () => {
  const { update, state } = await mount({ settled: false });
  expect(islands().setView).not.toHaveBeenCalled();
  await settle();
  expect(islands().setView).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      pitch: pitchOf(cameraAngles.chart.elevation),
    })
  );
  // Later stats do not move it again.
  await settle();
  expect(islands().setView).toHaveBeenCalledOnce();
  await update({
    chartSettings: { ...state.chartSettings, camera: { elevation: 90 } },
  });
  expect(islands().setView).toHaveBeenLastCalledWith(
    expect.objectContaining({ pitch: Math.PI / 2 })
  );
  await update({
    chartSettings: {
      ...state.chartSettings,
      camera: { elevation: cameraAngles.chart.elevation },
    },
  });
  expect(islands().setView).toHaveBeenLastCalledWith(
    expect.objectContaining({ pitch: pitchOf(cameraAngles.chart.elevation) })
  );
});

it("treats a map closed while its chart loads as no failure", async () => {
  let reject: (error: unknown) => void = () => undefined;
  vi.mocked(loadIslandsChart).mockImplementationOnce(
    () =>
      new Promise((_, failed) => {
        reject = failed;
      })
  );
  await mount();
  await act(() => root.unmount());
  await act(async () => {
    reject(new DOMException("The operation was aborted.", "AbortError"));
    await Promise.resolve();
  });
  expect(releaseFirstFrame).not.toHaveBeenCalled();
  expect(createIslands).not.toHaveBeenCalled();
  root = createRoot(container);
});

it("opens Islands with the reduced-motion setting as it stands when the chart arrives", async () => {
  let changed: () => void = () => undefined;
  const query = {
    addEventListener: vi.fn((_: string, listener: () => void) => {
      changed = listener;
    }),
    matches: false,
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => query),
  });
  type Loaded = Awaited<ReturnType<typeof loadIslandsChart>>;
  let resolve: (value: Loaded) => void = () => undefined;
  vi.mocked(loadIslandsChart).mockImplementationOnce(
    () =>
      new Promise<Loaded>((done) => {
        resolve = done;
      })
  );
  await mount();
  expect(createIslands).not.toHaveBeenCalled();
  query.matches = true;
  await act(() => changed());
  await act(async () => {
    resolve({
      chart: { foundations: [], groups: [], islands: [], modules: [] },
      notes: [],
    } as unknown as Loaded);
    await Promise.resolve();
  });
  expect(createIslands).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      controls: expect.objectContaining({ reducedMotion: true }),
      settings: expect.objectContaining({ waveAmplitude: 0 }),
    })
  );
});
