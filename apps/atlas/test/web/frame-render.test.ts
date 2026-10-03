import { afterEach, expect, it, vi } from "vitest";
import { createFrameRenderer } from "../../src/web/scene/frame-render";

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
