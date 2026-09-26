import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearWind,
  insidePolygons,
  islandAt,
  windPath,
} from "../../src/web/atmosphere";
import { createAtmosphereLayer } from "../../src/web/atmosphere-layer";
import type { AtlasData, Polygon, Territory } from "../../src/web/types";

const square: Polygon = [
  [
    [-10, -10],
    [10, -10],
    [10, 10],
    [-10, 10],
    [-10, -10],
  ],
];
const territory: Territory = {
  analyzed: true,
  coast: [square],
  color: "#d9be83",
  files: [],
  hills: [],
  id: "island",
  label: "island",
  neighborhoods: [],
  radius: 20,
  shallows: [square],
  x: 100,
  y: 100,
};
const data: AtlasData = {
  coverage: "partial",
  fileEdges: [],
  generatedAt: "",
  height: 800,
  routes: [],
  territories: [territory],
  width: 800,
};

describe("atmosphere placement", () => {
  it("follows real polygons, including holes and detached islands", () => {
    const hole: Polygon = [
      ...square,
      [
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, 2],
        [-2, -2],
      ],
    ];
    expect(insidePolygons({ x: 0, y: 0 }, [hole])).toBe(false);
    expect(insidePolygons({ x: 5, y: 0 }, [hole])).toBe(true);
    expect(islandAt({ x: 100, y: 100 }, [territory])?.id).toBe("island");
    expect(islandAt({ x: 0, y: 0 }, [territory])).toBeUndefined();
  });
  it("keeps a repeatable wind gesture clear of land, labels, routes and map edges", () => {
    const path = windPath({ x: 0, y: 0 }, 1);
    expect(path).toEqual(windPath({ x: 0, y: 0 }, 1));
    expect(clearWind(path, data, [], 14)).toBe(true);
    expect(clearWind(windPath({ x: 100, y: 100 }, 1), data, [], 14)).toBe(
      false
    );
    expect(clearWind(windPath({ x: 390, y: 0 }, 1), data, [], 14)).toBe(false);
    expect(
      clearWind(
        path,
        data,
        [
          {
            font: "12px serif",
            height: 15,
            territory,
            text: "label",
            width: 30,
            x: 0,
            y: 5,
          },
        ],
        14
      )
    ).toBe(false);
    const linked = {
      ...data,
      routes: [{ from: "a", sharedConcepts: 0, to: "b", weight: 1 }],
      territories: [
        { ...territory, id: "a", x: -150, y: 0 },
        { ...territory, id: "b", x: 150, y: 0 },
      ],
    };
    expect(clearWind(windPath({ x: 0, y: -18 }, 1), linked, [], 14)).toBe(
      false
    );
  });
});

function setup(
  reduced = false,
  ocean?: Parameters<typeof createAtmosphereLayer>[2],
  frameDuration = 16
) {
  vi.useFakeTimers();
  const ctx = {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    resetTransform: vi.fn(),
    scale: vi.fn(),
    stroke: vi.fn(),
  };
  const canvas = {
    getContext: () => ctx,
    height: 0,
    remove: vi.fn(),
    setAttribute: vi.fn(),
    width: 0,
  };
  const motion = {
    addEventListener: vi.fn(),
    matches: reduced,
    removeEventListener: vi.fn(),
  };
  const documentEvents = vi.fn();
  vi.stubGlobal("document", {
    addEventListener: documentEvents,
    createElement: () => canvas,
    hidden: false,
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", { matchMedia: () => motion, setTimeout });
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => {
      cb(performance.now());
    }, frameDuration)
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn();
      disconnect = disconnect;
    }
  );
  const host = {
    append: vi.fn(),
    clientHeight: 600,
    clientWidth: 800,
  } as unknown as HTMLElement;
  return {
    canvas,
    ctx,
    disconnect,
    documentEvents,
    layer: createAtmosphereLayer(host, (p) => p, ocean),
    motion,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bounded atmosphere lifecycle", () => {
  it("seeks exact shader times, stays paused across camera changes, and resumes", () => {
    const update = vi.fn<(time: number, enabled: boolean) => void>();
    const { layer } = setup(false, { strength: () => 1, update });
    layer.setCurrentTime(0);
    expect(update.mock.lastCall).toEqual([0, true]);
    layer.setCurrentTime(5000);
    vi.advanceTimersByTime(1000);
    layer.cameraChanged();
    expect(update.mock.lastCall).toEqual([5000, true]);
    expect(vi.getTimerCount()).toBe(0);
    layer.setCurrentTime(Number.NaN);
    layer.setCurrentTime(-1);
    expect(update.mock.lastCall).toEqual([5000, true]);
    layer.setCurrentTime(null);
    vi.advanceTimersByTime(1000);
    expect(update.mock.lastCall?.[0]).toBeGreaterThan(5900);
    layer.dispose();
  });
  it("allows explicit seeking with reduced motion without enabling playback", () => {
    const update = vi.fn<(time: number, enabled: boolean) => void>();
    const { layer } = setup(true, { strength: () => 1, update });
    layer.setCurrentTime(10_000);
    expect(update.mock.lastCall).toEqual([10_000, true]);
    expect(vi.getTimerCount()).toBe(0);
    layer.setCurrentTime(null);
    expect(update.mock.lastCall).toEqual([8000, true]);
    expect(vi.getTimerCount()).toBe(0);
    layer.dispose();
  });
  it("advances at wall-clock speed even when rendering takes 300ms per frame", () => {
    const update = vi.fn<(time: number, enabled: boolean) => void>();
    const { layer } = setup(false, { strength: () => 1, update }, 300);
    layer.cameraChanged();
    vi.advanceTimersByTime(3000);
    expect(update.mock.lastCall?.[0]).toBe(9000);
    layer.dispose();
  });
  it("animates overview atmosphere, stops in detail, resumes and tears down", () => {
    const ocean = {
      dispose: vi.fn(),
      strength: vi.fn(() => 1),
      update: vi.fn(),
    };
    const { layer } = setup(false, ocean);
    layer.cameraChanged();
    vi.advanceTimersByTime(1000);
    expect(ocean.update.mock.calls.length).toBeGreaterThan(20);
    expect(ocean.update.mock.calls.length).toBeLessThan(35);
    ocean.strength.mockReturnValue(0);
    layer.cameraChanged();
    vi.advanceTimersByTime(100);
    expect(vi.getTimerCount()).toBe(0);
    ocean.strength.mockReturnValue(1);
    layer.cameraChanged();
    expect(vi.getTimerCount()).toBe(1);
    layer.setEnabled(false);
    expect(vi.getTimerCount()).toBe(0);
    layer.setEnabled(true);
    expect(vi.getTimerCount()).toBe(1);
    layer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("paints reduced-motion ocean at a fixed time without scheduling frames", () => {
    const ocean = {
      strength: () => 1,
      update: vi.fn<(time: number, enabled: boolean) => void>(),
    };
    const { layer } = setup(true, ocean);
    layer.cameraChanged();
    vi.advanceTimersByTime(1000);
    layer.cameraChanged();
    expect(ocean.update.mock.calls.map((call) => call[0])).toEqual([
      8000, 8000,
    ]);
    expect(vi.getTimerCount()).toBe(0);
    layer.dispose();
  });
  it("pauses in a hidden tab and restarts only when visible", () => {
    const ocean = { strength: () => 1, update: vi.fn() };
    const { layer, documentEvents } = setup(false, ocean);
    layer.cameraChanged();
    const listener = documentEvents.mock.calls.find(
      (call) => call[0] === "visibilitychange"
    )?.[1] as EventListener;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    listener(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    listener(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(1);
    layer.dispose();
  });
  it("settles coastlight and wind without an idle animation loop", () => {
    const { layer, ctx } = setup();
    layer.highlight(territory);
    vi.advanceTimersByTime(1500);
    expect(ctx.stroke).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    layer.wind(() => windPath({ x: 0, y: 0 }, 1));
    vi.advanceTimersByTime(3500);
    expect(vi.getTimerCount()).toBe(0);
    layer.dispose();
  });
  it("keeps static reduced-motion emphasis and never schedules wind", () => {
    const { layer, ctx } = setup(true);
    const path = vi.fn(() => windPath({ x: 0, y: 0 }, 1));
    layer.highlight(territory);
    layer.wind(path);
    vi.advanceTimersByTime(5000);
    expect(ctx.stroke).toHaveBeenCalled();
    expect(path).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    layer.dispose();
  });
  it("cancels pending gestures on camera movement, disabling and teardown", () => {
    const { layer, canvas, motion, disconnect } = setup();
    const path = vi.fn(() => windPath({ x: 0, y: 0 }, 1));
    layer.wind(path);
    layer.cameraChanged();
    vi.advanceTimersByTime(1500);
    expect(path).not.toHaveBeenCalled();
    layer.wind(path);
    layer.setEnabled(false);
    expect(vi.getTimerCount()).toBe(0);
    layer.setEnabled(true);
    layer.wind(path);
    layer.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(canvas.remove).toHaveBeenCalled();
    expect(motion.removeEventListener).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });
});
