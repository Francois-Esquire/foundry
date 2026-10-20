import { afterEach, expect, it, vi } from "vitest";
import {
  createFrameRenderer,
  sceneAnimating,
} from "../../src/web/scene/frame-render";
import type { SceneLayer } from "../../src/web/scene/handle";

afterEach(() => vi.unstubAllGlobals());

it("draws one frame for a burst of camera events and cancels queued work on disposal", () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    sequence += 1;
    callbacks.set(sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const draw = vi.fn();
  const renderer = createFrameRenderer(draw);
  for (let index = 0; index < 30; index += 1) {
    renderer.request();
  }
  expect(callbacks.size).toBe(1);
  expect(draw).not.toHaveBeenCalled();
  callbacks.get(1)?.(0);
  expect(draw).toHaveBeenCalledTimes(1);
  expect(callbacks.size).toBe(0);
  renderer.request();
  const late = callbacks.get(2);
  renderer.dispose();
  late?.(0);
  renderer.request();
  expect(draw).toHaveBeenCalledTimes(1);
  expect(callbacks.size).toBe(0);
});

it("draws the next frame unasked while a layer animates, and stops when it stops or motion is reduced", () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    sequence += 1;
    callbacks.set(sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const draw = vi.fn();
  let moving = true;
  const reducedMotion = { matches: false };
  const layers: SceneLayer[] = [
    { dispose: vi.fn(), id: "still" },
    { animating: () => moving, dispose: vi.fn(), id: "water" },
  ];
  const renderer = createFrameRenderer(draw, () =>
    sceneAnimating(layers, reducedMotion)
  );
  /** Runs the one frame queued, as the display would. */
  const frame = () => {
    const [id, callback] = [...callbacks].at(-1) ?? [];
    callbacks.delete(id ?? 0);
    callback?.(0);
  };
  renderer.request();
  frame();
  expect(draw).toHaveBeenCalledTimes(1);
  // The layer is moving, so the next frame is queued without a request.
  expect(callbacks.size).toBe(1);
  frame();
  expect(draw).toHaveBeenCalledTimes(2);
  expect(callbacks.size).toBe(1);
  // Reduced motion stills the loop after the frame that shows the change.
  reducedMotion.matches = true;
  frame();
  expect(draw).toHaveBeenCalledTimes(3);
  expect(callbacks.size).toBe(0);
  reducedMotion.matches = false;
  renderer.request();
  frame();
  expect(callbacks.size).toBe(1);
  // The layer coming to rest ends the loop the same way.
  moving = false;
  frame();
  expect(draw).toHaveBeenCalledTimes(5);
  expect(callbacks.size).toBe(0);
  renderer.dispose();
});
