// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DeveloperFrameRate from "../../src/web/ui/developer-frame-rate";
import DeveloperTools from "../../src/web/ui/developer-tools";
import { createSpyglassState } from "../../src/web/ui/spyglass-state";
import { useSpyglassState } from "../../src/web/ui/use-spyglass-state";
import { loadSpyglass } from "../helpers/reference-spyglass";

let root: Root;
let container: HTMLDivElement;
let deliver: (
  list: Pick<PerformanceObserverEntryList, "getEntriesByName">
) => void;
const disconnect = vi.fn();
const takeRecords = vi.fn(() => []);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      constructor(callback: typeof deliver) {
        deliver = callback;
      }
      observe() {
        /* Delivery is controlled by each test. */
      }
      disconnect = disconnect;
      takeRecords = takeRecords;
    }
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount(frameRate = false, onOpen = vi.fn()) {
  const initial = createSpyglassState(await loadSpyglass(), true);
  function Harness() {
    const { state, ...actions } = useSpyglassState(initial);
    return frameRate
      ? createElement(DeveloperFrameRate, { actions, onOpen, state })
      : createElement(DeveloperTools, { actions, section: "layers", state });
  }
  await act(() => root.render(createElement(Harness)));
}

it("counts actual frame submissions, reports idle, and disconnects on unmount", async () => {
  await mount(true);
  const entries = [{ name: "spyglass:render-submit" }] as PerformanceEntry[];
  const byName = vi.fn(() => entries);
  await act(() => {
    deliver({ getEntriesByName: byName });
    vi.advanceTimersByTime(1000);
  });
  expect(byName).toHaveBeenCalledWith("spyglass:render-submit");
  expect(container.querySelector(".spyglass-fps")?.textContent).toContain(
    "1FPS"
  );
  await act(() => vi.advanceTimersByTime(1000));
  expect(container.querySelector(".spyglass-fps")?.textContent).toContain(
    "0FPS"
  );
  await act(() => root.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
  root = createRoot(container);
});

it("keeps the counter out of sidebar content", async () => {
  await mount();
  expect(container.querySelector("dialog")).toBeNull();
  expect(
    container.querySelector('[aria-label="Map frames per second"]')
  ).toBeNull();
  expect(container.textContent).toContain("Layout and boundaries");
  expect(container.textContent).not.toContain("Lighting and color");
  expect(container.textContent).not.toContain("Scene composition");
});

it("opens development settings from the app-bar counter", async () => {
  const onOpen = vi.fn();
  await mount(true, onOpen);
  await act(() =>
    container.querySelector<HTMLButtonElement>(".spyglass-fps")?.click()
  );
  expect(onOpen).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("Layout and boundaries");
});
