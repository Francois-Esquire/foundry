import { Color } from "three";
import {
  color,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  fwidth,
  max,
  mix,
  mx_noise_float,
  positionLocal,
  sign,
  smoothstep,
  vec2,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { grounds } from "../ladder/ink-ladder";

/**
 * The geology preview's land above the water, finer than the height grid
 * can carry. The bake gives each vertex its tread's tone: the island's
 * pigment as a pastel, a little lighter toward the summit, richer in
 * hollows and paler on exposed ground. The material then cuts the surface
 * per pixel: sand on the beach and wet toward the waterline, escarpments
 * in layered sandstone from a crisp edge, and a fine relief of rills,
 * rock grain and undulation that tilts the normal for light alone. Every
 * edge is antialiased on screen and every fine layer fades before it is
 * a few pixels across, so nothing shimmers as the camera draws back. The
 * shading reads only elevation, slope and position, never how many
 * terraces an island has or where they stand.
 */
export const defaultLandSurfaceSettings = {
  /**
   * Sand under `top`, elevation: just over the landforms' beach bench at
   * 0.04, so the sand ends crisply on the foot of the first escarpment
   * along a level line of the ground. It is wet toward the waterline:
   * `wet.colour` at `wet.from` and none from `wet.to`, a deeper warm sand
   * rather than grey.
   */
  beach: {
    colour: "#f3e7ca",
    top: 0.065,
    wet: { colour: "#e6d4ae", from: 0.004, to: 0.034 },
  },
  /**
   * Land contours fade on escarpments by slope, elevation per map unit:
   * full on a tread, gone by `to`, so a riser draws itself without a
   * crowd of lines on it.
   */
  contourFade: { from: 0.04, to: 0.1 },
  /**
   * Land contours: nominal metres between levels and every how many is a
   * major. Fine enough that the gentle rise of each terrace's tread
   * carries a line or two once the camera comes in to an island.
   */
  contours: { interval: 25, majorEvery: 4 },
  /**
   * The light reads each surface as cut paper: a tread's slope is kept
   * `tread` of itself and an escarpment's raised to at least `riser`,
   * elevation per map unit, so its shading steps at the escarpment's edge
   * rather than rolling over it.
   */
  cut: { riser: 0.11, tread: 0.7 },
  /**
   * The fine relief, each layer a height in map units over a wavelength in
   * map units, added to the surface for light alone. `fade` is the screen
   * pixels a wavelength spans from which a layer comes in, full at `to`.
   * Rills groove escarpments downslope: `across` apart, `along` long, the
   * frame turning with the slope, re-anchored every `cell` map units so a
   * curving riser does not shear them, and their grooves lose `occlusion`
   * of the sky. Grain roughens escarpment rock; undulation swells treads.
   */
  detail: {
    fade: { from: 2.5, to: 6 },
    grain: { height: 0.035, wavelength: 0.9 },
    rills: { across: 0.8, along: 6, cell: 6, height: 0.12, occlusion: 0.12 },
    /** Slope over which the escarpments' relief comes in, elevation per map unit. */
    steep: { from: 0.045, to: 0.1 },
    undulation: { height: 0.12, wavelength: 9 },
  },
  /**
   * The cut edges wander with a low noise of `wavelength` map units: the
   * escarpment's edge by up to `slope` and the beach's by up to
   * `elevation`, so neither traces the lattice.
   */
  edge: { elevation: 0.006, slope: 0.008, wavelength: 3.5 },
  /**
   * Escarpments a share of the way to bare sandstone, from a crisp edge at
   * `slope`, elevation per map unit: past the beach's own seaward face and
   * a tread's gentle climb, short of a riser's middle. The light then
   * shades them by the way they face.
   */
  escarpment: { colour: "#c09c72", share: 0.6, slope: 0.07 },
  /**
   * Colour life within a tread, baked a vertex. Where the ground around a
   * vertex stands over it, by `hollow.curvature` in elevation units, the
   * pigment is deepened `hollow.deepen` further from the paper: richer in
   * hollows and ravines, never darker. Where the vertex stands over its
   * ground by `exposed.curvature`, it goes `exposed.lift` of the way back
   * to the paper. A slope facing the sun warms by `aspect.warm`, one turned
   * from it cools by `aspect.cool`, by its share of `aspect.slope`.
   */
  life: {
    aspect: { cool: "#c8d4e6", share: 0.06, slope: 0.08, warm: "#f6dcb4" },
    exposed: { curvature: { from: 0.12, to: 0.4 }, lift: 0.18 },
    hollow: { curvature: { from: 0.02, to: 0.16 }, deepen: 0.3 },
  },
  /**
   * Each island's pigment is washed toward the paper for the chart; on
   * the terrain it is deepened back away from it by `deepen`, so tops
   * read as chalky pastels, sage, butter, peach, lavender and mint,
   * rather than as cream.
   */
  pigment: { deepen: 0.6, paper: grounds.land },
  /**
   * Layers in the escarpments' sandstone at fixed elevations, two
   * families `spacing` elevation units apart, the first weighed `weight`,
   * so the beds are uneven. Each bed is `contrast` lighter or darker, the
   * pale beds `tint.share` toward a rose, and on escarpments stands
   * `relief` of its thickness proud for light. Beds come in from `fade` screen pixels
   * apart, full at `to`, and wander by `warp` of a bed with the edges'
   * noise.
   */
  strata: {
    contrast: 0.07,
    fade: { from: 4, to: 9 },
    relief: 0.1,
    spacing: [0.052, 0.021],
    tint: { colour: "#e6b9ae", share: 0.25 },
    warp: 0.3,
    weight: 0.65,
  },
  /** How much lighter the summit is than the shore, as a share of the pigment. */
  summitLift: 0.08,
};
export type LandSurfaceSettings = typeof defaultLandSurfaceSettings;

/** Below this many units per pixel a field is flat on screen. */
const flatFootprint = 1e-6;

function smooth(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** How far past an edge a value is, in its own change across a pixel: 0 to 1 over a pixel and a half, centred on the edge. */
function crispStep(value: number, edge: number, footprint: number): number {
  return smooth(
    -0.75,
    0.75,
    (value - edge) / Math.max(footprint, flatFootprint)
  );
}

/** `crispStep` as a node, its footprint the value's own change across a pixel. */
function crispStepNode(
  value: Node<"float">,
  edge: Node<"float"> | number
): Node<"float"> {
  return smoothstep(
    -0.75,
    0.75,
    value.sub(edge).div(max(fwidth(value), flatFootprint))
  );
}

/**
 * How much of a fine layer shows, 0 to 1: none until its wavelength spans
 * `fade.from` screen pixels, all from `fade.to`. `footprint` is map units
 * a pixel. The CPU twin of the material's fade.
 */
export function detailFade(
  wavelength: number,
  footprint: number,
  fade: LandSurfaceSettings["detail"]["fade"] = defaultLandSurfaceSettings
    .detail.fade
): number {
  return footprint >= flatFootprint
    ? smooth(fade.from, fade.to, wavelength / footprint)
    : 0;
}

function detailFadeNode(
  wavelength: number,
  footprint: Node<"float">,
  fade: LandSurfaceSettings["detail"]["fade"]
): Node<"float"> {
  return smoothstep(
    fade.from,
    fade.to,
    float(wavelength).div(max(footprint, flatFootprint))
  );
}

/** One family of beds: -1 in a dark bed, 1 in a pale one, softly stepped between. */
function bed(coordinate: number): number {
  const offset = Math.abs(coordinate - Math.floor(coordinate) - 0.5);
  return smooth(0.12, 0.36, offset) * 2 - 1;
}

/**
 * The escarpments' strata at an elevation: `tone`, the sandstone's
 * brightness, 1 between beds, and `tint`, the share of the rose the pale
 * beds take. `footprint` is the elevation's change across a screen pixel;
 * beds narrower on screen than the fade fade out, the finer family first.
 * The CPU twin of the material's strata, without the warp.
 */
export function strataShade(options: {
  elevation: number;
  footprint: number;
  settings?: LandSurfaceSettings["strata"];
}): { tint: number; tone: number } {
  const { settings = defaultLandSurfaceSettings.strata } = options;
  const [coarse = 1, fine = 1] = settings.spacing;
  const resolved = (spacing: number) =>
    options.footprint >= flatFootprint
      ? smooth(
          settings.fade.from,
          settings.fade.to,
          spacing / options.footprint
        )
      : 0;
  const first = bed(options.elevation / coarse) * resolved(coarse);
  const second = bed(options.elevation / fine + 0.37) * resolved(fine);
  const layered = settings.weight * first + (1 - settings.weight) * second;
  return {
    tint: settings.tint.share * Math.max(0, first),
    tone: 1 + settings.contrast * layered,
  };
}

/** The land's surface cover at a point, each 0 to 1. */
export interface LandCover {
  /** Sand: the beach bench and the foot of the first escarpment, under a level line. */
  beach: number;
  /** Escarpment: from the crisp edge at the escarpment's slope. */
  riser: number;
  /** How wet the beach's sand is, toward the waterline. */
  wet: number;
}

/**
 * The land's cover at an elevation and slope, elevation per map unit,
 * each with its change across a screen pixel: escarpment from a crisp edge
 * on the slope, sand over it below a crisp edge on the elevation, wet
 * toward the waterline. The CPU twin of the
 * material's cover, without the edges' wander.
 */
export function landCover(options: {
  elevation: number;
  footprint: { elevation: number; slope: number };
  settings?: LandSurfaceSettings;
  slope: number;
}): LandCover {
  const { footprint, settings = defaultLandSurfaceSettings } = options;
  const riser = crispStep(
    options.slope,
    settings.escarpment.slope,
    footprint.slope
  );
  return {
    beach:
      1 - crispStep(options.elevation, settings.beach.top, footprint.elevation),
    riser,
    wet:
      1 -
      smooth(settings.beach.wet.from, settings.beach.wet.to, options.elevation),
  };
}

/** What the bake reads of one land vertex for its tone. */
export interface LandToneSample {
  /**
   * How far the mean elevation around the vertex stands over it, in
   * elevation units: positive in a hollow, negative on exposed ground.
   */
  curvature: number;
  elevation: number;
  /**
   * The vertex's elevation gradient per map unit, x right and y down the
   * chart, and the map direction toward the sun, unit length.
   */
  gradient: readonly [number, number];
  sunBearing: readonly [number, number];
}

/** The land's palette in linear light, from its settings' hex. */
export function landPalette(settings: LandSurfaceSettings) {
  return {
    cool: new Color(settings.life.aspect.cool),
    paper: new Color(settings.pigment.paper),
    warm: new Color(settings.life.aspect.warm),
  };
}

/**
 * One land vertex's tread tone into `tone`: its island's pigment deepened
 * to a pastel, deeper still in hollows and paler on exposed ground, a
 * little lighter toward the summit, warmer facing the sun and cooler
 * turned from it. Sand and escarpment are the material's, cut per pixel
 * over this tone.
 */
export function landTone(
  tone: Color,
  pigment: Color,
  sample: LandToneSample,
  palette: ReturnType<typeof landPalette>,
  settings: LandSurfaceSettings = defaultLandSurfaceSettings
): Color {
  const { life } = settings;
  const hollow = smooth(
    life.hollow.curvature.from,
    life.hollow.curvature.to,
    sample.curvature
  );
  const exposed = smooth(
    life.exposed.curvature.from,
    life.exposed.curvature.to,
    -sample.curvature
  );
  tone
    .copy(pigment)
    .lerp(
      palette.paper,
      -(settings.pigment.deepen + life.hollow.deepen * hollow)
    );
  tone.setRGB(
    Math.min(1, Math.max(0, tone.r)),
    Math.min(1, Math.max(0, tone.g)),
    Math.min(1, Math.max(0, tone.b))
  );
  tone.lerp(palette.paper, life.exposed.lift * exposed);
  const [gx, gy] = sample.gradient;
  const slope = Math.hypot(gx, gy);
  // Ground facing the sun falls toward it: its gradient points away.
  const facing =
    slope > flatFootprint
      ? (-(gx * sample.sunBearing[0] + gy * sample.sunBearing[1]) / slope) *
        smooth(0, life.aspect.slope, slope)
      : 0;
  return tone
    .lerp(
      facing > 0 ? palette.warm : palette.cool,
      life.aspect.share * Math.abs(facing)
    )
    .multiplyScalar(1 + settings.summitLift * sample.elevation);
}

/**
 * The normal of a surface raised by `height` along `normal`, from the
 * screen derivatives of the position and the height: Mikkelsen's bump
 * mapping of an unparametrised surface, in the position's space. The
 * derivatives are taken per pixel quad, so `height` must hold no detail
 * finer than a few pixels.
 */
function bumpedNormal(
  normal: Node<"vec3">,
  position: Node<"vec3">,
  height: Node<"float">
): Node<"vec3"> {
  const unit = normal.normalize();
  const alongX = dFdx(position);
  const alongY = dFdy(position);
  const r1 = cross(alongY, unit);
  const r2 = cross(unit, alongX);
  const determinant = dot(alongX, r1);
  const gradient = r1
    .mul(dFdx(height))
    .add(r2.mul(dFdy(height)))
    .mul(sign(determinant));
  return unit
    .mul(max(determinant.abs(), flatFootprint * flatFootprint))
    .sub(gradient)
    .normalize();
}

/** The corners of a cell, for blending patterns anchored on each. */
const cellCorners = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

/**
 * Rills, -1 to 1: noise stretched `along` down the slope and `across`
 * between grooves, in a frame turning with the downhill direction. The
 * frame is anchored at the corners of `cell`-wide cells and the four
 * blended smoothly, so a frame never turns about a far origin and the
 * grooves stay straight on a curving riser; the blend keeps the noise's
 * contrast.
 */
function rillsNode(
  point: Node<"vec2">,
  downhill: Node<"vec2">,
  settings: LandSurfaceSettings["detail"]["rills"]
): Node<"float"> {
  const across = vec2(downhill.y.negate(), downhill.x);
  const scaled = point.div(settings.cell);
  const base = scaled.floor();
  const within = scaled.fract();
  const blend = within.mul(within).mul(within.mul(-2).add(3));
  let sum: Node<"float"> = float(0);
  let weights: Node<"float"> = float(0);
  for (const [cx, cy] of cellCorners) {
    const corner = base.add(vec2(cx, cy));
    const local = point.sub(corner.mul(settings.cell));
    const weight = (cx ? blend.x : blend.x.oneMinus()).mul(
      cy ? blend.y : blend.y.oneMinus()
    );
    const noise = mx_noise_float(
      vec3(
        local.dot(across).div(settings.across),
        local.dot(downhill).div(settings.along),
        corner.dot(vec2(0.731, 1.379))
      )
    );
    sum = sum.add(noise.mul(weight));
    weights = weights.add(weight.mul(weight));
  }
  return sum.div(weights.sqrt());
}

/** The land's surface as the material shades it. */
export interface LandSurfaceNodes {
  /** The land's albedo: the bake's tone under sand and escarpment, with strata and grain. */
  albedo: Node<"vec3">;
  /** How much of the land contours show, 1 on treads to 0 mid-riser. */
  contours: Node<"float">;
  /** The normal raised by the fine relief, for light alone. */
  normal: Node<"vec3">;
  /** The sky share, with the rills' grooves taking a little of it. */
  sky: Node<"float">;
}

/**
 * The land's surface in the material: the bake's tread tone cut by the
 * cover `landCover` gives, with the edges' wander, strata as
 * `strataShade` gives, and the fine relief raised on the normal.
 * `normal` is the geometric normal in the mesh's space, x right, y up the
 * chart and z up in map units, and `exaggeration` the map units of height
 * an elevation unit stands.
 */
export function landSurfaceNode(options: {
  albedo: Node<"vec3">;
  elevation: Node<"float">;
  exaggeration: number;
  normal: Node<"vec3">;
  settings: LandSurfaceSettings;
  sky: Node<"float">;
}): LandSurfaceNodes {
  const { elevation, exaggeration, settings } = options;
  const { detail, strata } = settings;
  const position = positionLocal;
  const point = position.xy;
  // Map units a pixel spans on the ground, and on the surface itself.
  const footprint = max(dFdx(point).length(), dFdy(point).length());
  const surfaceFootprint = max(
    dFdx(position).length(),
    dFdy(position).length()
  );
  const geometric = options.normal.normalize();
  const run = geometric.xy.length();
  const slope = run.div(max(geometric.z, 0.05)).div(exaggeration);
  const downhill = geometric.xy.div(max(run, flatFootprint));
  const wander = mx_noise_float(
    point.div(settings.edge.wavelength).add(vec2(31.7, -12.3))
  );

  // Cover: escarpment past a crisp edge on the slope, sand under a crisp
  // level line over it, wet toward the waterline.
  const riser = crispStepNode(
    slope.add(wander.mul(settings.edge.slope)),
    settings.escarpment.slope
  );
  const beach = crispStepNode(
    elevation.add(wander.mul(settings.edge.elevation)),
    settings.beach.top
  ).oneMinus();
  const wet = smoothstep(
    settings.beach.wet.from,
    settings.beach.wet.to,
    elevation
  ).oneMinus();

  // Strata: two families of beds at fixed elevations, each faded where
  // its beds crowd on screen.
  const [coarse = 1, fine = 1] = strata.spacing;
  const bedNode = (coordinate: Node<"float">) =>
    smoothstep(0.12, 0.36, coordinate.fract().sub(0.5).abs()).mul(2).sub(1);
  const strataFade = (coordinate: Node<"float">) =>
    smoothstep(
      strata.fade.from,
      strata.fade.to,
      float(1).div(max(fwidth(coordinate), flatFootprint))
    );
  const coarseBeds = elevation.div(coarse).add(wander.mul(strata.warp));
  const fineBeds = elevation
    .div(fine)
    .add(0.37)
    .add(wander.mul(strata.warp * 0.6));
  const first = bedNode(coarseBeds).mul(strataFade(coarseBeds));
  const second = bedNode(fineBeds).mul(strataFade(fineBeds));
  const layered = first.mul(strata.weight).add(second.mul(1 - strata.weight));

  // The cut: the tread flattened and the escarpment steepened for light,
  // either side of the riser's crisp edge.
  const cutSlope = mix(
    slope.mul(settings.cut.tread),
    max(slope, settings.cut.riser),
    riser
  );
  const cutNormal = vec3(downhill.mul(cutSlope.mul(exaggeration)), 1);

  // Fine relief: rills and grain on escarpments, a swell on treads.
  const steep = smoothstep(detail.steep.from, detail.steep.to, slope);
  // Beds stand proud only on the escarpment, so a tread's climb is not lined.
  const escarpment = smoothstep(
    settings.escarpment.slope * 0.8,
    settings.escarpment.slope * 1.3,
    slope
  );
  const rills = rillsNode(point, downhill, detail.rills);
  const rillsShown = detailFadeNode(
    detail.rills.across,
    footprint,
    detail.fade
  );
  const grain = mx_noise_float(position.div(detail.grain.wavelength));
  const grainShown = detailFadeNode(
    detail.grain.wavelength,
    surfaceFootprint,
    detail.fade
  );
  const undulation = mx_noise_float(
    point.div(detail.undulation.wavelength).add(vec2(-7.1, 19.4))
  );
  const undulationShown = detailFadeNode(
    detail.undulation.wavelength,
    footprint,
    detail.fade
  );
  const bedHeight = (strata.relief * coarse * exaggeration) / 2;
  const bedSwell = coarseBeds
    .mul(Math.PI * 2)
    .sin()
    .mul(strataFade(coarseBeds));
  const height = rills
    .abs()
    .mul(detail.rills.height)
    .mul(rillsShown)
    .add(grain.mul(detail.grain.height).mul(grainShown))
    .mul(steep)
    .add(bedSwell.mul(bedHeight).mul(escarpment))
    .add(
      undulation
        .mul(detail.undulation.height)
        .mul(undulationShown)
        .mul(steep.oneMinus())
    );

  const tread = options.albedo;
  const sandstone = mix(
    tread,
    color(settings.escarpment.colour),
    settings.escarpment.share
  );
  const bedded = mix(
    sandstone,
    color(strata.tint.colour),
    max(first, 0).mul(strata.tint.share)
  )
    .mul(layered.mul(strata.contrast).add(1))
    .mul(grain.mul(grainShown).mul(0.04).add(1));
  const sand = mix(
    color(settings.beach.colour),
    color(settings.beach.wet.colour),
    wet
  );
  const albedo = mix(mix(tread, bedded, riser), sand, beach);
  const groove = smoothstep(0, 0.25, rills.abs())
    .oneMinus()
    .mul(rillsShown)
    .mul(steep)
    .mul(detail.rills.occlusion);
  return {
    albedo,
    contours: smoothstep(
      settings.contourFade.from,
      settings.contourFade.to,
      slope
    ).oneMinus(),
    normal: bumpedNormal(cutNormal, position, height),
    sky: options.sky.mul(groove.oneMinus()),
  };
}
