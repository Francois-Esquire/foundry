import type { BoatPose, createSailing } from "../layout/sailing";
import type { ChartCamera, ChartView } from "./chart-camera";

interface Direction {
  x: number;
  y: number;
}

/** Explicit navigation owns its clock, independently of decorative/reduced-motion animation. */
export function createExploration(options: {
  camera: Pick<
    ChartCamera,
    | "captureView"
    | "restoreView"
    | "setPresentation"
    | "flyToPoint"
    | "followPoint"
  >;
  navigator: () => ReturnType<typeof createSailing>;
  render: () => void;
  setPose: (pose: BoatPose | null) => void;
  visible: () => boolean;
}) {
  let pose: BoatPose | null = null;
  let saved: ChartView | null = null;
  let direction: Direction = { x: 0, y: 0 };
  let following = false;
  let disposed = false;
  let frame = 0;
  let last = 0;
  const halt = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    direction = { x: 0, y: 0 };
  };
  const permitted = () =>
    Boolean(pose && options.visible() && options.navigator().canSail(pose));
  const tick = (time: number) => {
    frame = 0;
    if (!(pose && permitted())) {
      halt();
      return;
    }
    const seconds = Math.min(0.05, Math.max(0, (time - last) / 1000));
    last = time;
    const next = options.navigator().advance(pose, direction, seconds);
    const moved =
      next.x !== pose.x || next.y !== pose.y || next.heading !== pose.heading;
    pose = next;
    if (moved) {
      options.setPose(pose);
      if (following) {
        options.camera.followPoint(pose);
      }
      options.render();
    }
    if ((moved || seconds === 0) && (direction.x || direction.y)) {
      frame = requestAnimationFrame(tick);
    }
  };
  return {
    active: () => saved !== null,
    dispose() {
      disposed = true;
      halt();
      saved = null;
      pose = null;
      options.setPose(null);
    },
    followBoat() {
      if (pose && options.visible()) {
        following = true;
        options.camera.flyToPoint(pose);
      }
    },
    /** Hiding navigation layers or exposing land stops held input immediately. */
    refresh() {
      if (!permitted()) {
        halt();
      }
    },
    releaseFollow() {
      following = false;
    },
    start(): boolean {
      if (disposed || !options.visible()) {
        return false;
      }
      if (saved) {
        return true;
      }
      const view = options.camera.captureView();
      const spawned = options.navigator().spawn({ x: view.x, y: -view.y });
      if (!spawned) {
        return false;
      }
      saved = view;
      pose = spawned;
      following = true;
      options.setPose(pose);
      options.camera.setPresentation(1);
      options.camera.flyToPoint(pose);
      options.render();
      return true;
    },
    steer(input: Direction) {
      if (disposed || !permitted()) {
        halt();
        return;
      }
      direction = {
        x: Number.isFinite(input.x) ? input.x : 0,
        y: Number.isFinite(input.y) ? input.y : 0,
      };
      if (!(direction.x || direction.y)) {
        halt();
      } else if (!frame) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }
    },
    stop() {
      halt();
      const previous = saved;
      saved = null;
      pose = null;
      following = false;
      options.setPose(null);
      if (previous) {
        options.camera.restoreView(previous);
        options.render();
      }
    },
  };
}
