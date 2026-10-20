import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  Group,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
} from "three";
import {
  abs,
  attribute,
  clamp,
  dot,
  exp,
  float,
  fract,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  select,
  smoothstep,
  step,
  uniform,
  varying,
  vec2,
  vec3,
} from "three/tsl";
import {
  MeshBasicNodeMaterial,
  type Node,
  type UniformNode,
} from "three/webgpu";
import {
  defaultRingWaveSettings,
  type RingWave,
  type RingWaveSettings,
  ringWaves,
} from "../../lib/visualization/ring-waves";
import type { SpyglassData } from "../data/types";
import { chartHull } from "../layout/chart-hull";
import { isSceneLayerVisible } from "../settings/scene-composition";
import { type InkView, viewSquash } from "../view/chart-view";
import type { SceneClock } from "./clock";
import type { SceneLayer } from "./handle";

/**
 * Map units the waves' ribbons stand over the water level: just over the
 * wireframe's rings, so the two never fight for a pixel, and well under
 * the geology lattice's gap.
 */
const waveLift = 0.012;

/** Drawn after the water's sheets and the wireframe's rings, before the marks' first step. */
const waveRenderOrder = 0.0006;

/**
 * Band half widths the ribbon reaches either side of the crest: past the
 * trough behind it and the foam's furthest spread ahead. The wave's light
 * eases to nothing over the last `ribbonFeather` of them, so the ribbon's
 * edge never cuts it.
 */
const ribbonReach = 3.2;
const ribbonFeather = 0.7;

/** Screen pixels added to each side of a ribbon, so the lip's antialiased edge is never cut. */
const ribbonMargin = 1;

/** The share of the shown arc over which a crest tapers to nothing at each end. */
const endTaper = 0.55;

/**
 * Points the geometry draws between each pair of a crest's samples, on a
 * Catmull-Rom curve through them: at close range only a few samples are
 * shown, and the bow must stay a smooth curve across them.
 */
const subdivisions = 4;

/** The waves' uniforms, one per live tunable of `RingWaveSettings`. */
interface RingWaveUniforms {
  bandGaps: UniformNode<"float", number>;
  bandMinPixels: UniformNode<"float", number>;
  bandNarrow: UniformNode<"float", number>;
  bandOfArc: UniformNode<"float", number>;
  bandWiden: UniformNode<"float", number>;
  bowAspect: UniformNode<"float", number>;
  bowGaps: UniformNode<"float", number>;
  build: UniformNode<"float", number>;
  crash: UniformNode<"float", number>;
  crossing: UniformNode<"float", number>;
  fadeFrom: UniformNode<"float", number>;
  fadeTo: UniformNode<"float", number>;
  foam: UniformNode<"color", Color>;
  foamStrength: UniformNode<"float", number>;
  fold: UniformNode<"float", number>;
  glow: UniformNode<"color", Color>;
  glowStrength: UniformNode<"float", number>;
  lipPixels: UniformNode<"float", number>;
  lipStrength: UniformNode<"float", number>;
  maxPixels: UniformNode<"float", number>;
  peel: UniformNode<"float", number>;
  /** Screen pixels per map unit across the view, set each frame. */
  pixelsPerUnit: UniformNode<"float", number>;
  rest: UniformNode<"float", number>;
  rise: UniformNode<"float", number>;
  /** The camera's squash of the chart's north–south, `viewSquash`, set each frame. */
  squash: UniformNode<"float", number>;
  strength: UniformNode<"float", number>;
  swell: UniformNode<"color", Color>;
  swellStrength: UniformNode<"float", number>;
  translucency: UniformNode<"float", number>;
  trough: UniformNode<"float", number>;
}

/** The least share of a crossing between two of a wave's life keys, so the shader's smoothsteps stay ordered. */
const lifeStep = 1e-3;

/** Each live uniform set to the matching value of `settings`. */
function writeSettings(
  uniforms: RingWaveUniforms,
  settings: RingWaveSettings
): void {
  const { band, bow, life, look, motion } = settings;
  uniforms.bandGaps.value = Math.max(0, band.gaps);
  uniforms.bandMinPixels.value = Math.max(0.5, band.minPixels);
  uniforms.bandNarrow.value = band.narrow;
  uniforms.bandOfArc.value = Math.max(0, band.ofArc);
  uniforms.bandWiden.value = band.widen;
  uniforms.bowAspect.value = Math.max(0, bow.aspect);
  uniforms.bowGaps.value = Math.max(0, bow.gaps);
  // The life's keys, kept in order inside the crossing.
  const rise = Math.min(1 - 4 * lifeStep, Math.max(lifeStep, life.rise));
  const build = Math.min(
    1 - 3 * lifeStep,
    Math.max(rise + lifeStep, life.build)
  );
  const fold = Math.min(
    1 - 2 * lifeStep,
    Math.max(build + lifeStep, life.fold)
  );
  const crash = Math.min(1 - lifeStep, Math.max(fold + lifeStep, life.crash));
  uniforms.rise.value = rise;
  uniforms.build.value = build;
  uniforms.fold.value = fold;
  uniforms.crash.value = crash;
  uniforms.peel.value = Math.max(0, life.peel);
  uniforms.crossing.value = Math.max(1e-3, motion.crossing);
  uniforms.rest.value = Math.max(0, motion.rest);
  uniforms.fadeFrom.value = look.fade.from;
  uniforms.fadeTo.value = Math.max(look.fade.from + 1e-3, look.fade.to);
  uniforms.foam.value.set(look.foam);
  uniforms.foamStrength.value = look.foamStrength;
  uniforms.glow.value.set(look.glow);
  uniforms.glowStrength.value = look.glowStrength;
  uniforms.lipPixels.value = Math.max(0.5, look.lipPixels);
  uniforms.lipStrength.value = look.lipStrength;
  uniforms.maxPixels.value = look.maxPixels;
  uniforms.strength.value = look.strength;
  uniforms.swell.value.set(look.swell);
  uniforms.swellStrength.value = look.swellStrength;
  uniforms.translucency.value = Math.min(1, Math.max(0, look.translucency));
  uniforms.trough.value = look.trough;
}

type Point = readonly [number, number];

/**
 * The crest through `points` with `subdivisions` points per span on a
 * uniform Catmull-Rom curve, its ends held.
 */
function smoothCrest(points: readonly Point[]): Point[] {
  if (points.length < 2) {
    return [...points];
  }
  const out: Point[] = [];
  const at = (i: number) =>
    points[Math.min(points.length - 1, Math.max(0, i))] ?? [0, 0];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let k = 0; k < subdivisions; k += 1) {
      const t = k / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;
      const blend = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b +
          (c - a) * t +
          (2 * a - 5 * b + 4 * c - d) * t2 +
          (3 * b - a - 3 * c + d) * t3);
      out.push([
        blend(p0[0], p1[0], p2[0], p3[0]),
        blend(p0[1], p1[1], p2[1], p3[1]),
      ]);
    }
  }
  out.push(at(points.length - 1));
  return out;
}

/** The unit direction of a polyline at point `j`, by its neighbours, in world axes. */
function tangentAt(points: readonly Point[], j: number): [number, number] {
  const a = points[Math.max(0, j - 1)] ?? [0, 0];
  const b = points[Math.min(points.length - 1, j + 1)] ?? a;
  const dx = b[0] - a[0];
  // World y is map y turned over.
  const dy = a[1] - b[1];
  const length = Math.hypot(dx, dy) || 1;
  return [dx / length, dy / length];
}

/** Ribbon points per crest: its samples with `subdivisions` drawn per span. */
export function ringWaveCrestPoints(samples: number): number {
  return (samples - 1) * subdivisions + 1;
}

/**
 * The waves as one ribbon geometry: two vertices, either side of the
 * crest, at each point of its smoothed curve. Each vertex carries its
 * point at the start and end of the crossing and the crest's direction at
 * both, in world axes (world y is map y turned over); its place along the
 * crest from -1 to 1 and its side; the gap it crosses and the crest's half
 * length; and the wave's stagger and tempo. The shader moves it; the CPU
 * never does.
 */
function ringWaveGeometry(waves: readonly RingWave[]): BufferGeometry {
  const crests = waves.map((wave) => ({
    end: smoothCrest(wave.end),
    start: smoothCrest(wave.start),
    wave,
  }));
  let vertices = 0;
  let quads = 0;
  for (const { start } of crests) {
    vertices += start.length * 2;
    quads += start.length - 1;
  }
  const position = new Float32Array(vertices * 3);
  const startAttribute = new Float32Array(vertices * 2);
  const endAttribute = new Float32Array(vertices * 2);
  const tangents = new Float32Array(vertices * 4);
  const crest = new Float32Array(vertices * 4);
  const timing = new Float32Array(vertices * 2);
  const index = new Uint32Array(quads * 6);
  let vertex = 0;
  let corner = 0;
  for (const { end, start, wave } of crests) {
    const count = start.length;
    for (let j = 0; j < count; j += 1) {
      const from = start[j] ?? [0, 0];
      const to = end[j] ?? from;
      const [sx, sy] = tangentAt(start, j);
      const [ex, ey] = tangentAt(end, j);
      const along = count > 1 ? (2 * j) / (count - 1) - 1 : 0;
      for (const side of [-1, 1]) {
        position.set([from[0], -from[1], 0], vertex * 3);
        startAttribute.set([from[0], -from[1]], vertex * 2);
        endAttribute.set([to[0], -to[1]], vertex * 2);
        tangents.set([sx, sy, ex, ey], vertex * 4);
        crest.set([along, side, wave.gap, wave.length / 2], vertex * 4);
        timing.set([wave.offset, wave.tempo], vertex * 2);
        vertex += 1;
      }
      if (j < count - 1) {
        const base = vertex - 2;
        index.set(
          [base, base + 1, base + 2, base + 1, base + 3, base + 2],
          corner
        );
        corner += 6;
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("waveStart", new BufferAttribute(startAttribute, 2));
  geometry.setAttribute("waveEnd", new BufferAttribute(endAttribute, 2));
  geometry.setAttribute("waveTangents", new BufferAttribute(tangents, 4));
  geometry.setAttribute("waveCrest", new BufferAttribute(crest, 4));
  geometry.setAttribute("waveTiming", new BufferAttribute(timing, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

type FloatNode = Node<"float">;

/** `1 - x`, for the life's falling edges. */
const fall = (x: FloatNode): FloatNode => float(1).sub(x);

/**
 * `ringWaveLife` as shader nodes, for `phase` in crossings: every channel
 * 0 outside the crossing.
 */
function lifeNodes(phase: FloatNode, uniforms: RingWaveUniforms) {
  const live = step(0, phase).mul(fall(step(1, phase)));
  const fade = fall(smoothstep(uniforms.crash, 1, phase));
  const build = smoothstep(0, uniforms.build, phase);
  const pitched = smoothstep(uniforms.fold, uniforms.crash, phase);
  return {
    bow: smoothstep(0, uniforms.crash, phase).mul(live),
    build: build.mul(live),
    foam: pitched.mul(fade).mul(live),
    glow: smoothstep(uniforms.rise, uniforms.build, phase)
      .mul(fall(smoothstep(uniforms.build, uniforms.crash, phase)))
      .mul(live),
    lip: smoothstep(uniforms.build, uniforms.fold, phase)
      .mul(fall(pitched))
      .mul(live),
    opacity: smoothstep(0, uniforms.rise, phase).mul(fade).mul(live),
    pitch: smoothstep(uniforms.build, uniforms.crash, phase).mul(live),
    spread: smoothstep(uniforms.fold, 1, phase).mul(live),
    swell: build.mul(fall(pitched)).mul(live),
  };
}

/** Smooth gradient noise over `point`, about 0 to 1. */
const foamNoise = (point: Node<"vec2">): FloatNode =>
  mx_noise_float(point, 0.5, 0.5);

/** A Gaussian bump of `x` about `centre`, `width` wide to 1/e. */
const bump = (x: FloatNode, centre: number, width: number): FloatNode =>
  exp(x.sub(centre).div(width).pow(2).negate());

/**
 * The material that moves and inks the ribbons. Each wave's phase is
 * `ringWavePhase` of the clock; its crest goes from its start to its end
 * points as the phase runs from 0 to 1, its ends lagging its apex by
 * `ringWaveBow`, and its band of water is `band.gaps` of its gap wide in
 * map units. Across the band it draws, in premultiplied light: a darker
 * trough behind, the lifted water, the turquoise light through the face
 * ahead (added, never covering), the lip's bright line, and broken foam
 * spreading forward. `ringWaveLife` of each point's `ringWaveLocalPhase`
 * weighs them, so the fold peels out from the apex. A resting wave folds
 * to no width, so it draws no pixel.
 */
function ringWaveMaterial(
  clock: Pick<SceneClock, "time">,
  uniforms: RingWaveUniforms
): MeshBasicNodeMaterial {
  const startPoint = attribute<"vec2">("waveStart", "vec2");
  const endPoint = attribute<"vec2">("waveEnd", "vec2");
  const tangents = attribute<"vec4">("waveTangents", "vec4");
  const crest = attribute<"vec4">("waveCrest", "vec4");
  const timing = attribute<"vec2">("waveTiming", "vec2");
  const along = crest.x;
  const side = crest.y;
  const gap = crest.z;
  const halfLength = crest.w;

  const span = uniforms.rest.add(1);
  const cycles = clock.time
    .mul(timing.y)
    .div(uniforms.crossing.mul(span))
    .add(timing.x);
  const phase = fract(cycles).mul(span);
  const shown = fall(step(1, phase));
  const travelled = min(phase, 1);
  const life = lifeNodes(phase, uniforms);

  // The arc shown: its share of the crest's half length, held to
  // `maxPixels` on screen, and each point's place on it from -1 to 1.
  const arc = max(
    min(
      uniforms.maxPixels
        .mul(0.5)
        .div(max(halfLength.mul(uniforms.pixelsPerUnit), 1e-6)),
      1
    ),
    1e-4
  );
  const onArc = clamp(along.div(arc), -1, 1);
  const shownHalf = arc.mul(halfLength);

  // The bow: the ends lag the apex, never the apex leading, so every point
  // stays on the open sea its precomputed path crosses.
  const travel = normalize(endPoint.sub(startPoint));
  const lag = life.bow.mul(
    min(uniforms.bowGaps.mul(gap), uniforms.bowAspect.mul(shownHalf))
  );
  const centre = mix(startPoint, endPoint, travelled).sub(
    travel.mul(lag.mul(onArc.mul(onArc)))
  );
  // The bowed crest's direction: the path's, turned by the lag's slope,
  // which is flat past the shown arc's ends.
  const direction = normalize(mix(tangents.xy, tangents.zw, travelled));
  const inside = step(abs(along), arc);
  const bowed = normalize(
    direction
      .mul(halfLength)
      .sub(travel.mul(lag.mul(onArc).mul(2).div(arc).mul(inside)))
  );
  const turned = vec2(bowed.y.negate(), bowed.x);
  // Side +1 is ahead of the crest, the way it travels.
  const normal = turned.mul(
    select(dot(turned, travel).greaterThanEqual(0), float(1), float(-1))
  );
  // Screen pixels one map unit along the normal spans, the view's squash
  // shortening its north–south part.
  const normalPixels = max(
    uniforms.pixelsPerUnit.mul(
      vec2(normal.x, normal.y.mul(uniforms.squash)).length()
    ),
    1e-6
  );
  const bandMap = min(
    uniforms.bandGaps
      .mul(gap)
      .mul(
        float(1)
          .sub(uniforms.bandNarrow.mul(life.build))
          .add(uniforms.bandWiden.mul(life.spread))
      ),
    uniforms.bandOfArc.mul(shownHalf)
  );
  const bandPixels = max(bandMap.mul(normalPixels), uniforms.bandMinPixels);
  const halfPixels = bandPixels.mul(ribbonReach).add(ribbonMargin);
  const offset = normal.mul(side.mul(halfPixels).div(normalPixels)).mul(shown);

  const material = new MeshBasicNodeMaterial({
    blendDst: OneMinusSrcAlphaFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    blendEquation: AddEquation,
    // Premultiplied: the glow adds light, the trough darkens, the foam covers.
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendSrcAlpha: OneFactor,
    depthWrite: false,
    side: DoubleSide,
    transparent: true,
  });
  material.positionNode = vec3(centre.add(offset), 0);

  // Per fragment: across the band in its half widths, ahead positive.
  const acrossPixels = varying(side.mul(halfPixels));
  const band = varying(bandPixels);
  const across = acrossPixels.div(band);
  const place = varying(onArc);
  const alongPixels = varying(
    along.mul(halfLength).mul(uniforms.pixelsPerUnit)
  );
  const wavePhase = varying(phase);
  const seed = varying(timing.x.mul(97));
  const envelope = varying(
    life.opacity.mul(
      smoothstep(
        uniforms.fadeFrom,
        uniforms.fadeTo,
        gap.mul(uniforms.pixelsPerUnit)
      )
    )
  );
  const localPhase = wavePhase.sub(uniforms.peel.mul(place.mul(place)));
  const local = lifeNodes(localPhase, uniforms);

  // The lifted water: a gentle back behind the crest and a steep face
  // ahead, turned to light through the face as it glows.
  const lift = select(
    across.lessThan(0),
    bump(across, 0, 1.2),
    bump(across, 0, 0.45)
  );
  const swellCover = uniforms.swellStrength
    .mul(local.swell)
    .mul(lift)
    .mul(fall(uniforms.translucency.mul(local.glow)));
  const troughCover = uniforms.trough
    .mul(local.swell)
    .mul(bump(across, -1.8, 0.8));
  const glowLight = uniforms.glowStrength
    .mul(local.glow)
    .mul(bump(across, 0.5, 0.75));
  // The lip: a bright line pitching forward from the crest, with a soft halo.
  const lipDistance = abs(
    acrossPixels.sub(mix(0.1, 0.7, local.pitch).mul(band))
  );
  const lipHalf = uniforms.lipPixels.mul(0.5);
  const lipLine = fall(
    smoothstep(lipHalf.sub(0.6), lipHalf.add(0.6), lipDistance)
  );
  const lipHalo = exp(
    lipDistance.div(uniforms.lipPixels.mul(2.5)).pow(2).negate()
  ).mul(0.35);
  const lipCover = uniforms.lipStrength
    .mul(local.lip)
    .mul(max(lipLine, lipHalo));
  // The whitewater: a bright broken front running forward from the fold,
  // with softer streaks of foam left behind it, that widens as it spreads
  // and dissolves into patches as it fades.
  const foamFront = mix(0.5, 2.3, local.spread);
  const foamBack = mix(0.1, 0.9, local.spread);
  const foamBody = smoothstep(foamBack.sub(0.5), foamBack.add(0.3), across).mul(
    fall(smoothstep(foamFront.sub(0.15), foamFront.add(0.15), across))
  );
  const foamEdge = exp(
    across.sub(foamFront.sub(0.18)).div(0.22).pow(2).negate()
  );
  const noisePoint = vec2(
    alongPixels.div(band.mul(1.1)),
    across.mul(1.6).sub(local.spread.mul(3))
  ).add(seed);
  const noise = foamNoise(noisePoint)
    .mul(0.65)
    .add(foamNoise(noisePoint.mul(2.3).add(17)).mul(0.35));
  const dissolve = smoothstep(uniforms.crash, 1, localPhase);
  const foamMask = smoothstep(
    dissolve.mul(0.55).add(0.2),
    dissolve.mul(0.55).add(0.48),
    noise
  );
  const foamCover = uniforms.foamStrength
    .mul(local.foam)
    .mul(foamEdge.mul(0.9).add(foamBody.mul(0.45)))
    .mul(foamMask);

  const ends = fall(smoothstep(1 - endTaper, 1, abs(place)));
  const edge = fall(
    smoothstep(ribbonReach - ribbonFeather, ribbonReach, abs(across))
  );
  const weight = envelope.mul(ends).mul(edge).mul(uniforms.strength);
  const white = lipCover.add(foamCover);
  const light = uniforms.swell
    .mul(swellCover)
    .add(uniforms.glow.mul(glowLight))
    .add(uniforms.foam.mul(white));
  const cover = min(swellCover.add(troughCover).add(white), 1);
  material.colorNode = light.mul(weight);
  material.opacityNode = cover.mul(weight);
  return material;
}

/** The waves' mesh, its uniforms, and a hook to bring them to the view. */
function buildRingWaves(options: {
  clock: Pick<SceneClock, "time">;
  data: Pick<SpyglassData, "frames" | "territories">;
  extent: { height: number; width: number };
  settings: RingWaveSettings;
}) {
  const { settings } = options;
  const hull = chartHull(options.data, options.extent);
  const waves = ringWaves(hull.field, hull.rings(), settings);
  const uniforms: RingWaveUniforms = {
    bandGaps: uniform(0),
    bandMinPixels: uniform(1),
    bandNarrow: uniform(0),
    bandOfArc: uniform(0),
    bandWiden: uniform(0),
    bowAspect: uniform(0),
    bowGaps: uniform(0),
    build: uniform(0.5),
    crash: uniform(0.8),
    crossing: uniform(1),
    fadeFrom: uniform(0),
    fadeTo: uniform(1),
    foam: uniform(new Color(settings.look.foam)),
    foamStrength: uniform(0),
    fold: uniform(0.6),
    glow: uniform(new Color(settings.look.glow)),
    glowStrength: uniform(0),
    lipPixels: uniform(1),
    lipStrength: uniform(0),
    maxPixels: uniform(1),
    peel: uniform(0),
    pixelsPerUnit: uniform(1),
    rest: uniform(0),
    rise: uniform(0.1),
    squash: uniform(1),
    strength: uniform(0),
    swell: uniform(new Color(settings.look.swell)),
    swellStrength: uniform(0),
    translucency: uniform(0),
    trough: uniform(0),
  };
  writeSettings(uniforms, settings);
  const geometry = ringWaveGeometry(waves);
  const material = ringWaveMaterial(options.clock, uniforms);
  const mesh = new Mesh(geometry, material);
  mesh.position.z = waveLift;
  mesh.renderOrder = waveRenderOrder;
  // The vertices move in the shader, so the geometry's bounds are not the drawn ones.
  mesh.frustumCulled = false;
  return {
    /** Writes `next` into the live uniforms; the waves' sites stay as built. */
    configure: (next: RingWaveSettings) => writeSettings(uniforms, next),
    count: waves.length,
    dispose() {
      geometry.dispose();
      material.dispose();
      for (const node of Object.values(uniforms)) {
        node.dispose();
      }
    },
    mesh,
    /** Brings the screen-space widths and fades to `view`: two uniform writes. */
    setView(view: Pick<InkView, "pixelsPerUnit" | "tilt">) {
      uniforms.pixelsPerUnit.value = view.pixelsPerUnit;
      uniforms.squash.value = viewSquash(view);
    },
    uniforms,
  };
}

type RingWavesMesh = ReturnType<typeof buildRingWaves>;

/**
 * The ring waves: swells that start on the outer hull's rings and travel
 * inward to the next ring, building, folding and breaking, on the geology preview's
 * open sea. The rings themselves are not drawn. The layer shows only while
 * the geology preview does, so the default chart never builds or draws
 * it; then the waves are built, once, from the cached `chartHull`, and
 * animate for as long as it shows. A frame writes two uniforms.
 */
export function createRingWavesLayer(options: {
  clock: Pick<SceneClock, "time">;
  data: Pick<SpyglassData, "frames" | "territories">;
  extent: { height: number; width: number };
  settings?: RingWaveSettings;
}): SceneLayer & { waves: () => RingWavesMesh } {
  const group = new Group();
  let built: RingWavesMesh | undefined;
  const waves = () => {
    if (!built) {
      built = buildRingWaves({
        ...options,
        settings: options.settings ?? defaultRingWaveSettings,
      });
      group.add(built.mesh);
    }
    return built;
  };
  return {
    animating: () => true,
    dispose() {
      built?.dispose();
    },
    enabled: (state) =>
      isSceneLayerVisible(state.settings.composition, "geology"),
    group,
    id: "ring-waves",
    kind: "layer",
    stats: (): Record<string, number> =>
      built
        ? {
            vertices: built.mesh.geometry.getAttribute("position").count,
            waves: built.count,
          }
        : {},
    update(view) {
      waves().setView(view);
    },
    waves,
  };
}
