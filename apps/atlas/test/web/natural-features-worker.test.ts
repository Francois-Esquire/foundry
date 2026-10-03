// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { BelongingRegion } from "../../src/web/belonging";
import type { AtlasInternals } from "../../src/web/internals";
import type { NaturalFeatures } from "../../src/web/natural-features";
import type { Territory } from "../../src/web/types";
import { useNaturalFeatures } from "../../src/web/ui/use-natural-features";

const data = {
  fileIds: {},
  responsibilities: { relationships: [], unresolved: [] },
} as unknown as AtlasInternals;
const territory: Territory = {
  analyzed: true,
  coast: [],
  color: "#aaa",
  files: [],
  hills: [],
  id: "island",
  label: "Island",
  neighborhoods: [],
  radius: 40,
  shallows: [],
  x: 0,
  y: 0,
};
const features: NaturalFeatures = {
  confluences: [],
  landmarks: [],
  marshes: [],
  omitted: [],
  rivers: [],
  streams: [],
  unrouted: 0,
};
const workers: TestWorker[] = [];
class TestWorker {
  onmessage: ((event: MessageEvent<NaturalFeatures>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
}
function Probe({ regions }: { regions: BelongingRegion[] }) {
  const result = useNaturalFeatures(territory, regions, data);
  return createElement("output", null, result?.unrouted ?? "pending");
}

afterEach(() => {
  workers.length = 0;
  vi.unstubAllGlobals();
});

it("cancels an old drawing and rejects a late result after switching regions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", TestWorker);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(() => root.render(createElement(Probe, { regions: [] })));
    const [oldWorker] = workers;
    const late = oldWorker?.onmessage;
    expect(host.textContent).toBe("pending");
    await act(() => root.render(createElement(Probe, { regions: [] })));
    expect(oldWorker?.terminate).toHaveBeenCalled();
    expect(oldWorker?.onmessage).toBeNull();
    const current = workers.at(-1);
    await act(() =>
      current?.onmessage?.(
        new MessageEvent("message", { data: { ...features, unrouted: 7 } })
      )
    );
    expect(host.textContent).toBe("7");
    await act(() => late?.(new MessageEvent("message", { data: features })));
    expect(host.textContent).toBe("7");
    expect(current?.terminate).toHaveBeenCalled();
  } finally {
    await act(() => root.unmount());
  }
});

it("retains feature construction in environments without workers", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", undefined);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(() => root.render(createElement(Probe, { regions: [] })));
    expect(host.textContent).toBe("0");
  } finally {
    await act(() => root.unmount());
  }
});
