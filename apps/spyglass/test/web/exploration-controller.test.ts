import { afterEach, expect, it, vi } from "vitest";
import type { BoatPose } from "../../src/web/layout/sailing";
import { createExploration } from "../../src/web/scene/exploration";

function clock() {
  let now = 0;
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    next += 1;
    frames.set(next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return {
    pending: () => frames.size,
    step(ms: number) {
      now += ms;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) {
        callback(now);
      }
    },
  };
}

function build() {
  const timer = clock();
  const saved = { pixels: 2.3, x: 10, y: -20 };
  const camera = {
    captureView: vi.fn(() => saved),
    flyToPoint: vi.fn(),
    followPoint: vi.fn(),
    restoreView: vi.fn(),
  };
  const navigator = {
    advance: vi.fn(
      (
        pose: BoatPose,
        direction: { x: number; y: number },
        seconds: number
      ): BoatPose => ({
        heading: Math.atan2(direction.y, direction.x),
        x: pose.x + direction.x * seconds * 20,
        y: pose.y + direction.y * seconds * 20,
      })
    ),
    canSail: vi.fn(() => true),
    spawn: vi.fn((): BoatPose | null => ({ heading: 0, x: 15, y: 25 })),
  };
  const visible = vi.fn(() => true);
  const setPose = vi.fn();
  const render = vi.fn();
  const controller = createExploration({
    camera,
    navigator: () => navigator,
    render,
    setPose,
    visible,
  });
  return {
    camera,
    controller,
    navigator,
    render,
    saved,
    setPose,
    timer,
    visible,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("captures the exact camera, starts at nearby water, idles without a frame loop, and restores once", () => {
  const { camera, controller, navigator, saved, setPose, timer } = build();
  expect(controller.start()).toBe(true);
  expect(navigator.spawn).toHaveBeenCalledWith({ x: 10, y: 20 });
  expect(setPose).toHaveBeenCalledWith({ heading: 0, x: 15, y: 25 });
  expect(camera.flyToPoint).toHaveBeenCalledWith({ heading: 0, x: 15, y: 25 });
  expect(timer.pending()).toBe(0);
  expect(controller.start()).toBe(true);
  expect(camera.captureView).toHaveBeenCalledTimes(1);
  controller.stop();
  expect(controller.active()).toBe(false);
  expect(setPose).toHaveBeenLastCalledWith(null);
  expect(camera.restoreView).toHaveBeenCalledWith(saved);
  controller.stop();
  expect(camera.restoreView).toHaveBeenCalledTimes(1);
});

it("moves only for held explicit input, caps background time, and releases or re-engages following", () => {
  const { camera, controller, navigator, timer } = build();
  controller.start();
  controller.steer({ x: 1, y: 0 });
  expect(timer.pending()).toBe(1);
  timer.step(0);
  expect(timer.pending()).toBe(1);
  timer.step(20);
  expect(navigator.advance).toHaveBeenLastCalledWith(
    expect.anything(),
    { x: 1, y: 0 },
    0.02
  );
  expect(camera.followPoint).toHaveBeenLastCalledWith({
    heading: 0,
    x: 15.4,
    y: 25,
  });
  timer.step(30_000);
  expect(navigator.advance).toHaveBeenLastCalledWith(
    expect.anything(),
    { x: 1, y: 0 },
    0.05
  );
  controller.releaseFollow();
  camera.followPoint.mockClear();
  timer.step(20);
  expect(camera.followPoint).not.toHaveBeenCalled();
  controller.followBoat();
  expect(camera.flyToPoint).toHaveBeenCalledTimes(2);
  timer.step(20);
  expect(camera.followPoint).toHaveBeenCalledTimes(1);
  controller.steer({ x: 0, y: 0 });
  expect(timer.pending()).toBe(0);
  const calls = navigator.advance.mock.calls.length;
  timer.step(1000);
  expect(navigator.advance).toHaveBeenCalledTimes(calls);
});

it("halts immediately when navigation is hidden or newly visible land invalidates the position", () => {
  const { controller, navigator, timer, visible } = build();
  controller.start();
  controller.steer({ x: 0, y: 1 });
  visible.mockReturnValue(false);
  controller.refresh();
  expect(timer.pending()).toBe(0);
  visible.mockReturnValue(true);
  controller.refresh();
  expect(timer.pending()).toBe(0);
  controller.steer({ x: 1, y: 0 });
  navigator.canSail.mockReturnValue(false);
  controller.refresh();
  expect(timer.pending()).toBe(0);
  controller.steer({ x: 1, y: 0 });
  expect(timer.pending()).toBe(0);
});

it("does not start without visible open water or resume after disposal", () => {
  const { camera, controller, navigator, timer, visible } = build();
  visible.mockReturnValue(false);
  expect(controller.start()).toBe(false);
  expect(camera.captureView).not.toHaveBeenCalled();
  visible.mockReturnValue(true);
  navigator.spawn.mockReturnValueOnce(null);
  expect(controller.start()).toBe(false);
  expect(controller.active()).toBe(false);
  expect(controller.start()).toBe(true);
  controller.steer({ x: 1, y: 0 });
  controller.dispose();
  expect(timer.pending()).toBe(0);
  expect(controller.start()).toBe(false);
  controller.steer({ x: 1, y: 0 });
  expect(timer.pending()).toBe(0);
  expect(camera.restoreView).not.toHaveBeenCalled();
});

it("rejects nonfinite input and stops spending frames against a stationary collision", () => {
  const { controller, navigator, timer } = build();
  controller.start();
  controller.steer({ x: Number.NaN, y: Number.POSITIVE_INFINITY });
  expect(timer.pending()).toBe(0);
  navigator.advance.mockImplementation((pose) => pose);
  controller.steer({ x: 1, y: 0 });
  timer.step(20);
  expect(timer.pending()).toBe(0);
  controller.steer({ x: 0, y: -1 });
  expect(timer.pending()).toBe(1);
  controller.stop();
});
