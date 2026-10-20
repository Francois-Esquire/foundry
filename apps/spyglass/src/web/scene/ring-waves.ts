import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
} from "three";
import {
  abs,
  attribute,
  exp,
  float,
  fract,
  max,
  min,
  mix,
  normalize,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { MeshBasicNodeMaterial, type UniformNode } from "three/webgpu";
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
 * Screen pixels added to each side of a ribbon past the glow's reach, so
 * the crest's antialiased edge and the glow's tail are never cut.
 */
const ribbonMargin = 1;

/** The share of the shown arc over which a crest tapers to nothing at each end. */
const endTaper = 0.6;

/** The waves' uniforms, one per live tunable of `RingWaveSettings`. */
interface RingWaveUniforms {
  collapseFrom: UniformNode<"float", number>;
  colour: UniformNode<"color", Color>;
  crest: UniformNode<"float", number>;
  crossing: UniformNode<"float", number>;
  fadeFrom: UniformNode<"float", number>;
  fadeTo: UniformNode<"float", number>;
  glow: UniformNode<"float", number>;
  glowStrength: UniformNode<"float", number>;
  maxPixels: UniformNode<"float", number>;
  /** Screen pixels per map unit across the view, set each frame. */
  pixelsPerUnit: UniformNode<"float", number>;
  rest: UniformNode<"float", number>;
  rise: UniformNode<"float", number>;
  /** The camera's squash of the chart's north–south, `viewSquash`, set each frame. */
  squash: UniformNode<"float", number>;
  strength: UniformNode<"float", number>;
}

/** Each live uniform set to the matching value of `settings`. */
function writeSettings(
  uniforms: RingWaveUniforms,
  settings: RingWaveSettings
): void {
  const { collapse, look, motion } = settings;
  uniforms.colour.value.set(look.colour);
  uniforms.collapseFrom.value = Math.min(0.999, collapse.from);
  uniforms.crest.value = look.crest;
  uniforms.crossing.value = Math.max(1e-3, motion.crossing);
  uniforms.fadeFrom.value = look.fade.from;
  uniforms.fadeTo.value = Math.max(look.fade.from + 1e-3, look.fade.to);
  uniforms.glow.value = Math.max(1e-3, look.glow);
  uniforms.glowStrength.value = look.glowStrength;
  uniforms.maxPixels.value = look.maxPixels;
  uniforms.rest.value = Math.max(0, motion.rest);
  uniforms.rise.value = Math.max(1e-3, collapse.rise);
  uniforms.strength.value = look.strength;
}

/** The unit direction of a polyline at point `j`, by its neighbours, in world axes. */
function tangentAt(
  points: readonly (readonly [number, number])[],
  j: number
): [number, number] {
  const a = points[Math.max(0, j - 1)] ?? [0, 0];
  const b = points[Math.min(points.length - 1, j + 1)] ?? a;
  const dx = b[0] - a[0];
  // World y is map y turned over.
  const dy = a[1] - b[1];
  const length = Math.hypot(dx, dy) || 1;
  return [dx / length, dy / length];
}

/**
 * The waves as one ribbon geometry: two vertices, either side of the
 * crest, at each of its points. Each vertex carries its point at the start
 * and end of the crossing and the crest's direction at both, in world
 * axes (world y is map y turned over); its place along the crest from -1
 * to 1 and its side; the gap it crosses and the crest's half length; and
 * the wave's stagger and tempo. The shader moves it; the CPU never does.
 */
function ringWaveGeometry(waves: readonly RingWave[]): BufferGeometry {
  let vertices = 0;
  let quads = 0;
  for (const wave of waves) {
    vertices += wave.start.length * 2;
    quads += wave.start.length - 1;
  }
  const position = new Float32Array(vertices * 3);
  const start = new Float32Array(vertices * 2);
  const end = new Float32Array(vertices * 2);
  const tangents = new Float32Array(vertices * 4);
  const crest = new Float32Array(vertices * 4);
  const timing = new Float32Array(vertices * 2);
  const index = new Uint32Array(quads * 6);
  let vertex = 0;
  let corner = 0;
  for (const wave of waves) {
    const count = wave.start.length;
    for (let j = 0; j < count; j += 1) {
      const from = wave.start[j] ?? [0, 0];
      const to = wave.end[j] ?? from;
      const [sx, sy] = tangentAt(wave.start, j);
      const [ex, ey] = tangentAt(wave.end, j);
      const along = count > 1 ? (2 * j) / (count - 1) - 1 : 0;
      for (const side of [-1, 1]) {
        position.set([from[0], -from[1], 0], vertex * 3);
        start.set([from[0], -from[1]], vertex * 2);
        end.set([to[0], -to[1]], vertex * 2);
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
  geometry.setAttribute("waveStart", new BufferAttribute(start, 2));
  geometry.setAttribute("waveEnd", new BufferAttribute(end, 2));
  geometry.setAttribute("waveTangents", new BufferAttribute(tangents, 4));
  geometry.setAttribute("waveCrest", new BufferAttribute(crest, 4));
  geometry.setAttribute("waveTiming", new BufferAttribute(timing, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

/**
 * The material that moves and inks the ribbons. Each wave's phase is
 * `ringWavePhase` of the clock; its crest goes from its start to its end
 * points as the phase runs from 0 to 1, keeps a width in screen pixels,
 * and takes `ringWaveEnvelope`'s length, width and opacity. A resting wave
 * folds to no width, so it draws no pixel.
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
  const travelled = min(phase, 1);
  const remaining = float(1).sub(smoothstep(uniforms.collapseFrom, 1, phase));
  const rise = smoothstep(0, uniforms.rise, phase);

  const centre = mix(startPoint, endPoint, travelled);
  const direction = normalize(mix(tangents.xy, tangents.zw, travelled));
  const normal = vec2(direction.y.negate(), direction.x);
  // Screen pixels one map unit along the normal spans, the view's squash
  // shortening its north–south part.
  const normalPixels = uniforms.pixelsPerUnit.mul(
    vec2(normal.x, normal.y.mul(uniforms.squash)).length()
  );
  const halfPixels = uniforms.crest
    .mul(0.5)
    .add(uniforms.glow.mul(2))
    .add(ribbonMargin);
  const shown = step(1e-4, remaining);
  const offset = normal
    .mul(side.mul(halfPixels).div(max(normalPixels, 1e-6)))
    .mul(shown);
  const material = new MeshBasicNodeMaterial({
    depthWrite: false,
    side: DoubleSide,
    transparent: true,
  });
  material.positionNode = vec3(centre.add(offset), 0);

  const across = abs(side).mul(halfPixels);
  const width = uniforms.crest.mul(remaining);
  const half = max(width, 1).mul(0.5);
  const line = float(1)
    .sub(smoothstep(half.sub(0.5), half.add(0.5), across))
    .mul(min(width, 1));
  const glow = exp(across.div(uniforms.glow).pow(2).negate())
    .mul(uniforms.glowStrength)
    .mul(remaining);
  const intensity = line.add(glow.mul(float(1).sub(line)));
  // The arc shown: the envelope's share, held to `maxPixels` on screen.
  const reach = min(
    uniforms.maxPixels
      .mul(0.5)
      .div(max(halfLength.mul(uniforms.pixelsPerUnit), 1e-6)),
    1
  );
  const arc = max(remaining.mul(reach), 1e-4);
  const ends = float(1).sub(smoothstep(arc.mul(1 - endTaper), arc, abs(along)));
  const resolved = smoothstep(
    uniforms.fadeFrom,
    uniforms.fadeTo,
    gap.mul(uniforms.pixelsPerUnit)
  );
  material.colorNode = uniforms.colour;
  material.opacityNode = intensity
    .mul(ends)
    .mul(rise)
    .mul(remaining)
    .mul(resolved)
    .mul(uniforms.strength);
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
    collapseFrom: uniform(0),
    colour: uniform(new Color(settings.look.colour)),
    crest: uniform(1),
    crossing: uniform(1),
    fadeFrom: uniform(0),
    fadeTo: uniform(1),
    glow: uniform(1),
    glowStrength: uniform(0),
    maxPixels: uniform(1),
    pixelsPerUnit: uniform(1),
    rest: uniform(0),
    rise: uniform(1),
    squash: uniform(1),
    strength: uniform(0),
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
 * The ring waves: swells that start on the outer hull's rings, travel
 * inward to the next ring and collapse there, on the geology preview's
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
