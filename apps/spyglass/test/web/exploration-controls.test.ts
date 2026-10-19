// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExplorationControls } from "../../src/web/ui/exploration-controls";
import { PresentationControl } from "../../src/web/ui/presentation-control";
import {
  createSpyglassState,
  type SpyglassState,
} from "../../src/web/ui/spyglass-state";
import { useSpyglassState } from "../../src/web/ui/use-spyglass-state";
import { loadSpyglass } from "../helpers/reference-spyglass";

const scene = {
  describe: vi.fn(() => []),
  focus: vi.fn(),
  focusWreck: vi.fn(),
  followBoat: vi.fn(),
  getRenderStatus: vi.fn(),
  startExploration: vi.fn(() => true),
  steer: vi.fn(),
  stopExploration: vi.fn(),
  zoom: vi.fn(),
};
let actions: ReturnType<typeof useSpyglassState>;
let root: Root;
let host: HTMLDivElement;
function Harness({ initial }: { initial: SpyglassState }) {
  actions = useSpyglassState(initial, undefined, false);
  const { scene: sceneRef, setSceneReady } = actions;
  useEffect(() => {
    sceneRef.current = scene;
    setSceneReady(true);
    return () => {
      setSceneReady(false);
      sceneRef.current = null;
    };
  }, [sceneRef, setSceneReady]);
  const context = { actions, onOpen: vi.fn(), state: actions.state };
  return createElement(
    "main",
    null,
    createElement(
      "div",
      { className: "spyglass-map" },
      createElement("canvas", { tabIndex: 0 })
    ),
    createElement("input", { "aria-label": "Search" }),
    createElement(PresentationControl, context),
    createElement(ExplorationControls, context)
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  scene.startExploration.mockReturnValue(true);
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.remove();
  }
});
async function mount() {
  const initial = createSpyglassState(await loadSpyglass());
  initial.chartSettings.presentation = 0.4;
  await act(() => root.render(createElement(Harness, { initial })));
}
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label || item.textContent === label
  );
  if (!found) {
    throw new Error(`Missing ${label}`);
  }
  return found;
}
async function start() {
  await act(() => button("Explore ocean").click());
}
function key(target: HTMLElement, type: "keydown" | "keyup", value: string) {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key: value,
  });
  target.dispatchEvent(event);
  return event;
}

it("enters the same scene and restores presentation on return, home, reset and scene replacement", async () => {
  await mount();
  const slider = host.querySelector<HTMLInputElement>('input[type="range"]');
  await start();
  expect(scene.startExploration).toHaveBeenCalledOnce();
  expect(actions.state.chartSettings.presentation).toBe(1);
  expect(slider?.disabled).toBe(true);
  await act(() => button("Follow boat").click());
  expect(scene.followBoat).toHaveBeenCalledOnce();
  await act(() => button("Return to atlas").click());
  expect(scene.stopExploration).toHaveBeenCalledOnce();
  expect(actions.state.chartSettings.presentation).toBe(0.4);
  expect(slider?.disabled).toBe(false);
  await start();
  await act(() => actions.home());
  expect(actions.exploring).toBe(false);
  expect(scene.focus).not.toHaveBeenCalled();
  await start();
  await act(() => actions.setSceneReady(false));
  expect(actions.exploring).toBe(false);
  expect(actions.state.chartSettings.presentation).toBe(0.4);
  await act(() => actions.setSceneReady(true));
  await start();
  await act(() => actions.reset());
  expect(actions.exploring).toBe(false);
  expect(actions.state.chartSettings.presentation).toBe(0);
});

it("keeps the atlas unchanged and explains a launch that has no visible ocean or safe spawn", async () => {
  await mount();
  scene.startExploration.mockReturnValue(false);
  await start();
  expect(actions.exploring).toBe(false);
  expect(actions.state.chartSettings.presentation).toBe(0.4);
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "open water to launch"
  );
});

it("steers only from the focused map or controls and stops on blur and dialog opening", async () => {
  await mount();
  await start();
  const canvas = host.querySelector("canvas");
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="Search"]'
  );
  if (!(canvas && input)) {
    throw new Error("Missing input surfaces");
  }
  canvas.focus();
  expect(key(canvas, "keydown", "w").defaultPrevented).toBe(true);
  expect(scene.steer).toHaveBeenLastCalledWith({ x: 0, y: -1 });
  key(canvas, "keydown", "ArrowRight");
  expect(scene.steer).toHaveBeenLastCalledWith({ x: 1, y: -1 });
  key(canvas, "keyup", "w");
  expect(scene.steer).toHaveBeenLastCalledWith({ x: 1, y: 0 });
  input.focus();
  expect(scene.steer).toHaveBeenLastCalledWith({ x: 0, y: 0 });
  const count = scene.steer.mock.calls.length;
  expect(key(input, "keydown", "ArrowRight").defaultPrevented).toBe(false);
  expect(scene.steer).toHaveBeenCalledTimes(count);
  canvas.focus();
  key(canvas, "keydown", "d");
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(scene.steer).toHaveBeenLastCalledWith({ x: 0, y: 0 });
  hidden.mockRestore();
  key(canvas, "keydown", "d");
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  await act(() => {
    dialog.open = true;
  });
  expect(scene.steer).toHaveBeenLastCalledWith({ x: 0, y: 0 });
  expect(key(canvas, "keydown", "w").defaultPrevented).toBe(false);
});

it("releases held pointer and keyboard direction buttons without leaving movement running", async () => {
  await mount();
  await start();
  const north = button("Sail north");
  north.setPointerCapture = vi.fn();
  await act(() =>
    north.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 7,
      })
    )
  );
  expect(north.setPointerCapture).toHaveBeenCalledWith(7);
  expect(scene.steer).toHaveBeenLastCalledWith(
    expect.objectContaining({ x: 0, y: -1 })
  );
  await act(() =>
    north.dispatchEvent(
      new PointerEvent("pointercancel", { bubbles: true, pointerId: 7 })
    )
  );
  expect(scene.steer).toHaveBeenLastCalledWith({ x: 0, y: 0 });
  key(north, "keydown", " ");
  expect(scene.steer).toHaveBeenLastCalledWith(
    expect.objectContaining({ x: 0, y: -1 })
  );
  key(north, "keyup", " ");
  expect(scene.steer).toHaveBeenLastCalledWith({ x: 0, y: 0 });
});
