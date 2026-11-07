/**
 * The camera: an orbit over the chart, its reversed-Z view, and the map-style
 * input that moves it. World space: chart `(x, y)` is
 * world `(x, 0, y)`, height is world `y`, sea level is `y = 0`, and north
 * (chart −y) is world −z.
 *
 * The projection is reversed-Z with an infinite far plane: depth is
 * `near / viewDistance`, 1 at the near plane and 0 at infinity. The film
 * clears to 0, terrain draws with `compare: "greater"`, and the water
 * composite reads a pixel's distance straight back as `near / depth`.
 */
import type { Chart, Point } from "../../../data/chart";
import { ignoresKeys, type KeyboardMode, listenKeys } from "./keys";

export type Vec3 = readonly [number, number, number];

export interface Orbit {
  /** Distance from the target, in chart units. */
  distance: number;
  /** Radians above the horizon: π/2 looks straight down. */
  pitch: number;
  /** The point looked at, world space. */
  target: Vec3;
  /** Radians around the vertical; 0 looks north. */
  yaw: number;
}

/** The camera for one frame: what the terrain and the composite need. */
export interface View {
  /** Image height over width's half-angle tangents: x and y. */
  readonly aperture: readonly [number, number];
  readonly eye: Vec3;
  readonly forward: Vec3;
  /** The near plane's distance: depth is `near / viewDistance`. */
  readonly near: number;
  readonly right: Vec3;
  readonly up: Vec3;
  /** Column-major, world to clip, reversed-Z and infinite. */
  readonly viewProjection: Float32Array;
}

/** Vertical field of view, degrees. */
const FIELD_OF_VIEW = 34;
const MIN_PITCH = 0.12;
const MAX_PITCH = 1.5607;
/** How close and how far the orbit may go, as shares of the fitted distance. */
const NEAREST = 0.025;
const FARTHEST = 2.5;
/** The near plane, as a share of the orbit distance. */
const NEAR_SHARE = 0.01;

const TAN_HALF_FOV = Math.tan((FIELD_OF_VIEW * Math.PI) / 360);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

/** Where the eye sits for an orbit. */
function eyeOf(orbit: Orbit): Vec3 {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  return [
    orbit.target[0] + Math.sin(orbit.yaw) * flat,
    orbit.target[1] + Math.sin(orbit.pitch) * orbit.distance,
    orbit.target[2] + Math.cos(orbit.yaw) * flat,
  ];
}

/** The view of an orbit through an image `aspect` (width over height) wide. */
export function viewOf(orbit: Orbit, aspect: number): View {
  const eye = eyeOf(orbit);
  const forward = normalize(sub(orbit.target, eye));
  // Straight down, the world's up is degenerate: north stays up the image.
  const sideways = cross(forward, [0, 1, 0]);
  const right = normalize(
    Math.hypot(...sideways) > 1e-6
      ? sideways
      : [Math.cos(orbit.yaw), 0, -Math.sin(orbit.yaw)]
  );
  const up = cross(right, forward);
  const near = Math.max(1e-3, orbit.distance * NEAR_SHARE);
  const fy = 1 / TAN_HALF_FOV;
  const fx = fy / Math.max(aspect, 1e-6);
  // Rows of clip = M · (p, 1): x and y by the focal lengths, z the constant
  // near (so depth = near / w), w the distance along the view.
  const rows = [
    [fx * right[0], fx * right[1], fx * right[2], -fx * dot(right, eye)],
    [fy * up[0], fy * up[1], fy * up[2], -fy * dot(up, eye)],
    [0, 0, 0, near],
    [forward[0], forward[1], forward[2], -dot(forward, eye)],
  ];
  const viewProjection = new Float32Array(16);
  for (const [row, values] of rows.entries()) {
    for (const [column, value] of values.entries()) {
      viewProjection[column * 4 + row] = value;
    }
  }
  return {
    aperture: [TAN_HALF_FOV * aspect, TAN_HALF_FOV],
    eye,
    forward,
    near,
    right,
    up,
    viewProjection,
  };
}

/** A world point in clip space: `[x, y, z, w]`. */
function toClip(view: View, point: Vec3): [number, number, number, number] {
  const m = view.viewProjection;
  // The view's matrix always holds sixteen entries, so the fallback never applies.
  const at = (index: number) => m[index] ?? 0;
  const [x, y, z] = point;
  return [
    at(0) * x + at(4) * y + at(8) * z + at(12),
    at(1) * x + at(5) * y + at(9) * z + at(13),
    at(2) * x + at(6) * y + at(10) * z + at(14),
    at(3) * x + at(7) * y + at(11) * z + at(15),
  ];
}

/** World units a pixel spans at `distance` along the view, for an image `height` px tall. */
function pixelSize(distance: number, height: number): number {
  return (2 * distance * TAN_HALF_FOV) / Math.max(1, height);
}

/**
 * A canvas point: CSS pixels from the top left, and whether it is in
 * front of the eye and inside the canvas.
 */
export interface Projected {
  /** In front of the eye and inside the canvas. */
  visible: boolean;
  /** Always finite: held within a canvas's size of its edges. */
  x: number;
  /** Always finite: held within a canvas's size of its edges. */
  y: number;
}

/** How near the eye's plane a point may come before it counts as behind it, along the view. */
const BEHIND = 1e-6;

/**
 * A world point on a canvas `width` by `height` CSS pixels. A point behind
 * the eye (or on its plane) is not visible, and its `x` and `y` lie off the
 * canvas on the side it is on; every `x` and `y` is held within one canvas
 * size of the edges, so it is finite and never NaN.
 */
export function projectView(
  view: View,
  point: Vec3,
  width: number,
  height: number
): Projected {
  const [clipX, clipY, , w] = toClip(view, point);
  const ahead = w > BEHIND;
  // Behind the eye the divide would mirror the point: keep its side, far out.
  const depth = ahead ? w : BEHIND;
  const across = clipX / depth;
  const up = clipY / depth;
  const hold = (value: number, size: number) =>
    Math.min(2 * size, Math.max(-size, value));
  return {
    visible: ahead && Math.abs(across) <= 1 && Math.abs(up) <= 1,
    x: hold(((across + 1) / 2) * width, width),
    y: hold(((1 - up) / 2) * height, height),
  };
}

/**
 * CSS pixels a world unit spans, across the view, at a world point, on a
 * canvas `height` CSS pixels tall; 0 for a point on or behind the eye's
 * plane.
 */
export function pixelsPerUnitAt(
  view: View,
  point: Vec3,
  height: number
): number {
  const along = dot(sub(point, view.eye), view.forward);
  if (along <= BEHIND) {
    return 0;
  }
  return Math.max(1, height) / (2 * along * TAN_HALF_FOV);
}

/** How much of the image's shorter half-side a framed circle's radius spans. */
const FRAME_SHARE = 0.6;

/**
 * The orbit over a circle of the chart (centre, radius in chart units),
 * keeping the current turn and tilt: close enough that the circle fills
 * `FRAME_SHARE` of the image's shorter half-side.
 */
export function frameOrbit(
  current: Orbit,
  centre: Point,
  radius: number,
  aspect: number
): Orbit {
  const halfSide = TAN_HALF_FOV * Math.min(1, Math.max(aspect, 1e-6));
  return {
    ...current,
    distance: Math.max(radius, 1e-3) / (FRAME_SHARE * halfSide),
    target: [centre[0], 0, centre[1]],
  };
}

/** Eases a share of a flight: slow out, slow in. */
const easeInOut = (t: number): number => {
  const s = Math.min(1, Math.max(0, t));
  return s < 0.5 ? 4 * s * s * s : 1 - (-2 * s + 2) ** 3 / 2;
};

/**
 * The orbit `t` of the way from `from` to `to` (no easing; 0 is `from`, 1
 * is `to`): the target and the pitch straight, the distance by its log so
 * a zoom feels even, and the turn the short way round.
 */
function blendOrbit(from: Orbit, to: Orbit, t: number): Orbit {
  if (t <= 0) {
    return from;
  }
  if (t >= 1) {
    return to;
  }
  const mix = (a: number, b: number) => a + (b - a) * t;
  const turn = to.yaw - from.yaw;
  const shortest = turn - 2 * Math.PI * Math.round(turn / (2 * Math.PI));
  return {
    distance: Math.exp(
      mix(
        Math.log(Math.max(from.distance, 1e-6)),
        Math.log(Math.max(to.distance, 1e-6))
      )
    ),
    pitch: mix(from.pitch, to.pitch),
    target: [
      mix(from.target[0], to.target[0]),
      mix(from.target[1], to.target[1]),
      mix(from.target[2], to.target[2]),
    ],
    yaw: from.yaw + shortest * t,
  };
}

/** The distance at which a chart's extent fills an image of this aspect. */
function fitDistance(chart: Chart, aspect: number): number {
  // A little over half the extent, so the margin of sea shows round it.
  const halfHeight = chart.extent.height * 0.56;
  const halfWidth = chart.extent.width * 0.56;
  const vertical = halfHeight / TAN_HALF_FOV;
  const horizontal = halfWidth / (TAN_HALF_FOV * Math.max(aspect, 1e-6));
  return Math.max(vertical, horizontal);
}

/** The pitch the chart opens at: high enough to read every island. */
const FIT_PITCH = 1.05;

/** The orbit that frames a whole chart, looking north. */
export function fit(chart: Chart, aspect: number): Orbit {
  // A tilted view sees the far half shrink; step back a little for it.
  const tilt = 1 + 0.25 * Math.cos(FIT_PITCH);
  return {
    distance: fitDistance(chart, aspect) * tilt,
    pitch: FIT_PITCH,
    target: [0, 0, 0],
    yaw: 0,
  };
}

/** Keeps an orbit within reach of the chart: pitch, zoom and target bounds. */
function clampOrbit(orbit: Orbit, chart: Chart, aspect: number): Orbit {
  const fitted = fitDistance(chart, aspect);
  const halfX = chart.extent.width * 0.6;
  const halfZ = chart.extent.height * 0.6;
  return {
    distance: Math.min(
      fitted * FARTHEST,
      Math.max(fitted * NEAREST, orbit.distance)
    ),
    pitch: Math.min(MAX_PITCH, Math.max(MIN_PITCH, orbit.pitch)),
    target: [
      Math.min(halfX, Math.max(-halfX, orbit.target[0])),
      orbit.target[1],
      Math.min(halfZ, Math.max(-halfZ, orbit.target[2])),
    ],
    yaw: orbit.yaw,
  };
}

const sameOrbit = (a: Orbit, b: Orbit) =>
  a.yaw === b.yaw &&
  a.pitch === b.pitch &&
  a.distance === b.distance &&
  a.target[0] === b.target[0] &&
  a.target[1] === b.target[1] &&
  a.target[2] === b.target[2];

/** Radians a pixel of drag turns and tilts. */
const TURN_PER_PIXEL = 0.006;
const TILT_PER_PIXEL = 0.005;
/** Image heights a held key pans a second. */
const KEY_PAN = 0.9;
/** Radians a held key turns a second. */
const KEY_TURN = 1.2;
/** Zoom per second while + or − is held, as a log factor. */
const KEY_ZOOM = 1.5;
const WHEEL_LINE = 0.05;
const WHEEL_PIXEL = 0.0015;
/** Longest step a held key advances, seconds: a stalled tab doesn't leap. */
const LONGEST_STEP = 0.1;

/** How long a flight takes, seconds. */
const FLIGHT_SECONDS = 0.6;

/** How the input may move the orbit. */
export interface ControlOptions {
  /** Where the keys listen (keys.ts); "window" by default. */
  keyboard?: KeyboardMode;
  /** Whether the camera may turn; false holds it looking north. True by default. */
  turn?: boolean;
}

export interface OrbitControls {
  /** Changes how the input may move the orbit; options left out keep their values. */
  configure: (options: ControlOptions) => void;
  dispose: () => void;
  /**
   * Flies to an orbit over `FLIGHT_SECONDS`, eased; any input, `set` or
   * a new flight takes over from it.
   */
  fly: (orbit: Orbit) => void;
  /** The orbit as it stands. */
  readonly orbit: Orbit;
  /** Replaces the orbit, as a fit does. */
  set: (orbit: Orbit) => void;
  /**
   * Advances held keys and a flight by `dt` seconds and clamps; true when
   * the orbit changed since the last update, by input, a flight or `set`.
   */
  update: (dt: number) => boolean;
}

/**
 * Map-style input on a canvas: drag pans, shift- or right-drag turns and
 * tilts, the wheel (or a pinch) zooms, WASD or the arrows pan, Q/E turn,
 * R/F tilt, +/− zoom. `bounds` gives the chart and image aspect the orbit
 * is clamped to. Keys typed into a field or inside an open dialog are left
 * alone (keys.ts `ignoresKeys`).
 */
export function createOrbitControls(
  canvas: HTMLCanvasElement,
  initial: Orbit,
  bounds: () => { aspect: number; chart: Chart | null },
  options: ControlOptions = {}
): OrbitControls {
  let orbit: Orbit = initial;
  let reported: Orbit | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  const keys = new Set<string>();
  let pinch = 0;
  let turning = false;
  let turns = options.turn ?? true;
  let keyboard: KeyboardMode = options.keyboard ?? "window";
  let flight: { elapsed: number; from: Orbit; to: Orbit } | null = null;

  const clamped = (next: Orbit): Orbit => {
    const { aspect, chart } = bounds();
    const held = chart ? clampOrbit(next, chart, aspect) : next;
    return turns ? held : { ...held, yaw: 0 };
  };
  const clamp = () => {
    orbit = clamped(orbit);
  };

  const pan = (dx: number, dy: number) => {
    const s = pixelSize(orbit.distance, canvas.clientHeight);
    const right = [Math.cos(orbit.yaw), -Math.sin(orbit.yaw)] as const;
    const ahead = [-Math.sin(orbit.yaw), -Math.cos(orbit.yaw)] as const;
    // A tilted view foreshortens the ground: a vertical drag moves farther.
    const stretch = 1 / Math.max(Math.sin(orbit.pitch), 0.35);
    const [x, y, z] = orbit.target;
    orbit = {
      ...orbit,
      target: [
        x + (-right[0] * dx + ahead[0] * dy * stretch) * s,
        y,
        z + (-right[1] * dx + ahead[1] * dy * stretch) * s,
      ],
    };
  };
  const turn = (dx: number, dy: number) => {
    orbit = {
      ...orbit,
      pitch: orbit.pitch + dy * TILT_PER_PIXEL,
      yaw: turns ? orbit.yaw - dx * TURN_PER_PIXEL : orbit.yaw,
    };
  };
  const zoom = (factor: number) => {
    orbit = { ...orbit, distance: orbit.distance * factor };
  };

  const keyPan = (t: number) => canvas.clientHeight * KEY_PAN * t;
  const keyTurn = (t: number) => (KEY_TURN * t) / TURN_PER_PIXEL;
  const keyTilt = (t: number) => (KEY_TURN * 0.6 * t) / TILT_PER_PIXEL;
  const bindings: readonly {
    act: (seconds: number) => void;
    keys: readonly string[];
  }[] = [
    { act: (t) => pan(keyPan(t), 0), keys: ["arrowleft", "a"] },
    { act: (t) => pan(-keyPan(t), 0), keys: ["arrowright", "d"] },
    { act: (t) => pan(0, keyPan(t)), keys: ["arrowup", "w"] },
    { act: (t) => pan(0, -keyPan(t)), keys: ["arrowdown", "s"] },
    { act: (t) => turn(-keyTurn(t), 0), keys: ["q"] },
    { act: (t) => turn(keyTurn(t), 0), keys: ["e"] },
    { act: (t) => turn(0, keyTilt(t)), keys: ["r"] },
    { act: (t) => turn(0, -keyTilt(t)), keys: ["f"] },
    { act: (t) => zoom(Math.exp(-KEY_ZOOM * t)), keys: ["=", "+"] },
    { act: (t) => zoom(Math.exp(KEY_ZOOM * t)), keys: ["-", "_"] },
  ];

  const onPointerDown = (event: PointerEvent) => {
    flight = null;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    turning = event.button === 2;
    const [a, b] = [...pointers.values()];
    if (pointers.size === 2 && a && b) {
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    const last = pointers.get(event.pointerId);
    if (!last) {
      return;
    }
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const [a, b] = [...pointers.values()];
    if (pointers.size === 2 && a && b) {
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0 && spread > 0) {
        zoom(pinch / spread);
      }
      pinch = spread;
      pan(dx / 2, dy / 2);
    } else if (turning || event.shiftKey || event.altKey) {
      turn(dx, dy);
    } else {
      pan(dx, dy);
    }
    clamp();
  };
  const onPointerUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    pinch = 0;
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    flight = null;
    const scale = event.deltaMode === 1 ? WHEEL_LINE : WHEEL_PIXEL;
    zoom(Math.exp(event.deltaY * scale));
    clamp();
  };
  const onContextMenu = (event: Event) => event.preventDefault();
  const onKeyDown = (event: KeyboardEvent) => {
    if (ignoresKeys(event.target) || event.metaKey || event.ctrlKey) {
      return;
    }
    const key = event.key.toLowerCase();
    if (bindings.some((binding) => binding.keys.includes(key))) {
      flight = null;
    }
    keys.add(key);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    keys.delete(event.key.toLowerCase());
  };
  const onBlur = () => keys.clear();
  const listen = () =>
    listenKeys(canvas, keyboard, {
      blur: onBlur,
      keydown: onKeyDown,
      keyup: onKeyUp,
    });

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  let unlisten = listen();

  return {
    configure(next) {
      if (next.turn !== undefined) {
        turns = next.turn;
        clamp();
      }
      if (next.keyboard !== undefined && next.keyboard !== keyboard) {
        ({ keyboard } = next);
        unlisten();
        keys.clear();
        unlisten = listen();
      }
    },
    dispose() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      unlisten();
    },
    fly(to) {
      flight = { elapsed: 0, from: orbit, to: clamped(to) };
    },
    get orbit() {
      return orbit;
    },
    set(next) {
      flight = null;
      orbit = next;
      clamp();
    },
    update(dt) {
      const seconds = Math.min(Math.max(dt, 0), LONGEST_STEP);
      if (flight) {
        flight.elapsed += seconds;
        const share = flight.elapsed / FLIGHT_SECONDS;
        orbit = blendOrbit(flight.from, flight.to, easeInOut(share));
        if (share >= 1) {
          flight = null;
        }
      }
      for (const binding of bindings) {
        if (binding.keys.some((key) => keys.has(key))) {
          binding.act(seconds);
        }
      }
      clamp();
      const changed = reported === null || !sameOrbit(reported, orbit);
      reported = orbit;
      return changed;
    },
  };
}
