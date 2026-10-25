import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import {
  atan,
  attribute,
  color,
  float,
  max,
  mix,
  normalWorld,
  positionGeometry,
  sin,
  smoothstep,
  uv,
} from "three/tsl";
import { MeshBasicNodeMaterial, type Node } from "three/webgpu";
import { unit } from "../../lib/visualization/geography";
import {
  depthBands,
  elevationAtDepth,
  geologyLevels,
  nominalDepth,
} from "../../lib/visualization/geology";
import type { SeaStack } from "../../lib/visualization/sea-stacks";
import { islandPigment } from "../layout/island-pigment";
import {
  defaultTerrainLightSettings,
  type TerrainLightSettings,
  terrainLightNode,
} from "./geology-light";
import { waterOpticsNode } from "./water-optics";

/**
 * Sea stacks drawn as one instanced mesh of a cluster of basalt columns:
 * hexagonal prisms packed side by side, the tallest at the heart and the
 * rest stepping down to a broken fringe, so from above a stack reads as a
 * small crisp honeycomb of tops at different heights. Each instance stands
 * on the seabed under it and rises to its stack's top. Above the water the
 * columns are pale weathered stone in two alternating tones, their tops
 * in their island's pigment; under it the rock is wet and seen through its
 * column of water as the seabed is. Round each stack the water answers it:
 * a thin ring of foam where a stack breaks the surface, and a pale shoal
 * glow over the shallows about it, all a submerged stack shows.
 */
export const defaultSeaStacksMeshSettings = {
  /** White water on the columns' walls at the waterline: elevation either side of it, and its strength. */
  collar: { reach: 0.01, strength: 0.85 },
  colours: {
    /** Weathered column walls above the splash zone, alternating column by column. */
    dry: ["#ded6c4", "#c8bda6"] as const,
    /** Wet rock below the water and in the splash zone, a shade under the seabed's sand. */
    wet: "#8f8672",
  },
  /** Column tops in their island's pigment, by the world normal's upward share, and how much of the pigment shows. */
  grass: { facing: { from: 0.7, to: 0.9 }, share: 0.85 },
  /**
   * The water about a stack, on a disc `reach` times its footprint's
   * radius. The foam is a soft, uneven wash at the foot of a stack that
   * breaks the surface, `width` of the disc's radius wide; the shoal a pale glow over
   * the shallows about any stack, its strength at full for a stack that
   * breaks the surface and fading for one deeper than `depth` nominal
   * metres to `deep` of it.
   */
  halo: {
    foam: { colour: "#f4fbf9", strength: 0.45, width: 0.12 },
    reach: 3.4,
    shoal: { colour: "#b4f6ee", deep: 0.4, depth: 20, strength: 0.5 },
  },
  /** Elevation each stack stands at least over the seabed under it, so none is buried. */
  minimumRise: 0.06,
  /** The share of the sky a column's foot against the seabed loses. */
  occlusion: { crease: 0.12, foot: 0.22 },
  /** How much taller a stack that breaks the surface stands above the water, so the columns read as pylons. */
  rise: 2.5,
  /**
   * The least light a wall keeps turned from the sun: pale stone in the
   * bright sky over the shallows, never a dark slot between columns.
   */
  shade: 0.68,
  /** Elevation above the water level the splash zone keeps wet. */
  splash: 0.012,
  /** The cluster's footprint as a share of its stack's radius. */
  spread: 1.35,
};
export type SeaStacksMeshSettings = typeof defaultSeaStacksMeshSettings;

export interface SeaStacksMeshOptions {
  /** Map units of height per elevation unit; the geology preview's is 14. */
  exaggeration?: number;
  /** The terrain's light, so the rock is lit as the seabed it stands on. */
  light?: TerrainLightSettings;
  /**
   * The seabed's elevation at a map position, in `geologyLevels` units, such
   * as the world field's `sample`: each stack's base stands on it.
   */
  sample: (x: number, y: number) => number;
  settings?: SeaStacksMeshSettings;
}

/** A column's circumradius, as a share of the cluster's unit spacing. */
const columnRadius = 0.3;

/** Centre-to-centre spacing of neighbouring columns: flat sides nearly touching. */
const columnSpacing = 0.54;

/**
 * The cluster's columns: each at a bearing and a distance in spacings from
 * the heart, and its height as a share of the stack's. The heart stands
 * tallest, its ring steps down unevenly, and a broken outer fringe stands
 * low, so the cluster's outline is ragged rather than a hexagon.
 */
const columns = [
  { bearing: 0, height: 1, ring: 0 },
  ...[0.86, 0.7, 0.93, 0.62, 0.78, 0.67].map((height, index) => ({
    bearing: Math.PI / 6 + (index * Math.PI) / 3,
    height,
    ring: 1,
  })),
  ...[0.42, 0.3, 0.5, 0, 0.36, 0].map((height, index) => ({
    bearing: Math.PI / 6 + (index * Math.PI) / 3,
    height,
    ring: 2,
  })),
  ...[0.26, 0, 0.34, 0.22, 0, 0.3].map((height, index) => ({
    bearing: (index * Math.PI) / 3,
    height,
    ring: Math.sqrt(3),
  })),
].filter(({ height }) => height > 0);

/** The cluster's reach from its heart to its outermost column's edge, so the unit footprint is radius 1. */
const clusterReach = 2 * columnSpacing + columnRadius;

/** The share of a column's radius its top edge rounds in over, and the height it takes. */
const bevel = { radius: 0.12, z: 0.02 };

/** How far below the seabed the columns reach, so no gap shows under a lean. */
const buried = -0.2;

/**
 * The unit cluster: radius about 1 across its footprint, the seabed at
 * z 0 and its tallest top at z 1, unindexed so each facet is shaded flat.
 * Each vertex carries the share of the sky it sees, `occlusion`, darker at
 * a column's foot, and its column's `band`, which alternates.
 */
export function seaStackGeometry(
  occlusion: SeaStacksMeshSettings["occlusion"] = defaultSeaStacksMeshSettings.occlusion
): BufferGeometry {
  const positions: number[] = [];
  const skies: number[] = [];
  const bands: number[] = [];
  const scale = 1 / clusterReach;
  const radius = columnRadius * scale;
  for (const [index, column] of columns.entries()) {
    const cx = Math.cos(column.bearing) * column.ring * columnSpacing * scale;
    const cy = Math.sin(column.bearing) * column.ring * columnSpacing * scale;
    const corner = (share: number, k: number, z: number, open: number) => {
      const angle = (k * Math.PI) / 3;
      return [
        cx + Math.cos(angle) * radius * share,
        cy + Math.sin(angle) * radius * share,
        z,
        open,
      ] as const;
    };
    const triangle = (...points: (readonly number[])[]) => {
      for (const [x = 0, y = 0, z = 0, open = 1] of points) {
        positions.push(x, y, z);
        skies.push(open);
        bands.push(index % 2);
      }
    };
    const top = column.height;
    const foot = 1 - occlusion.foot;
    const rings = [
      (k: number) => corner(1, k, buried, foot),
      (k: number) => corner(1, k, 0, foot),
      (k: number) => corner(1, k, top - bevel.z, 1),
      (k: number) => corner(1 - bevel.radius, k, top, 1),
    ];
    for (let ring = 1; ring < rings.length; ring += 1) {
      const below = rings[ring - 1];
      const above = rings[ring];
      if (below && above) {
        for (let k = 0; k < 6; k += 1) {
          const a = below(k);
          const b = below(k + 1);
          const c = above(k + 1);
          const d = above(k);
          triangle(a, b, c);
          triangle(a, c, d);
        }
      }
    }
    const cap = rings.at(-1);
    if (cap) {
      const centre = [cx, cy, top, 1] as const;
      for (let k = 0; k < 6; k += 1) {
        triangle(cap(k), cap(k + 1), centre);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("occlusion", new Float32BufferAttribute(skies, 1));
  geometry.setAttribute("band", new Float32BufferAttribute(bands, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/** `nominalDepth` as a node, through the depth bands' knots, as the terrain reads it. */
function depthNode(elevation: Node<"float">): Node<"float"> {
  const knots = [
    ...depthBands.map(({ from }) => from),
    nominalDepth(geologyLevels.trenchFloor),
  ].map((metres) => ({ depth: metres, elevation: elevationAtDepth(metres) }));
  let depth: Node<"float"> = float(0);
  for (let index = 1; index < knots.length; index += 1) {
    const upper = knots[index - 1];
    const lower = knots[index];
    if (upper && lower && upper.elevation > lower.elevation) {
      depth = depth.add(
        float(upper.elevation)
          .sub(elevation)
          .div(upper.elevation - lower.elevation)
          .clamp(0, 1)
          .mul(lower.depth - upper.depth)
      );
    }
  }
  return depth;
}

/**
 * The rock's material: unlit, since it lights itself as the terrain does,
 * by the terrain's light over its true facets and its baked creases. Each
 * fragment's elevation comes from its instance's base and top and its
 * height up the unit pillar, so it does not depend on where the mesh is put.
 */
function stackMaterial(
  settings: SeaStacksMeshSettings,
  light: TerrainLightSettings
) {
  const span = attribute<"vec2">("stackSpan", "vec2");
  const tint = attribute<"vec3">("stackTint", "vec3");
  const occlusion = attribute<"float">("occlusion", "float");
  const band = attribute<"float">("band", "float");
  const elevation = span.x.add(positionGeometry.z.mul(span.y.sub(span.x)));
  const normal = normalWorld.normalize();
  // Alternate columns take the stone's two tones.
  const [even, odd] = settings.colours.dry;
  const dry = mix(color(even), color(odd), band.mod(2));
  const rock = mix(
    color(settings.colours.wet),
    dry,
    smoothstep(0, settings.splash, elevation)
  );
  const tufts = smoothstep(
    settings.grass.facing.from,
    settings.grass.facing.to,
    normal.z
  )
    .mul(smoothstep(settings.splash, 2 * settings.splash, elevation))
    .mul(settings.grass.share);
  const collar = float(1)
    .sub(smoothstep(0, settings.collar.reach, elevation.abs()))
    .mul(settings.collar.strength);
  const albedo = mix(
    mix(rock, tint, tufts),
    color(settings.halo.foam.colour),
    collar
  );
  const lit = terrainLightNode({
    normal,
    relief: 1,
    settings: light,
    sky: occlusion,
    sun: float(1),
  });
  const optics = waterOpticsNode({
    depth: depthNode(elevation),
    seabedColour: albedo.mul(max(lit, settings.shade)),
  });
  const material = new MeshBasicNodeMaterial();
  material.colorNode = optics.colour;
  return {
    dispose() {
      material.dispose();
      optics.dispose();
    },
    material,
  };
}

/** World axes: x right, y up the chart (map y turned over), z up. */
const up = new Vector3(0, 0, 1);

/** Map units the halo lies over the water level: over the surface's sheet, under everything drawn on the chart. */
const haloLift = 0.02;

/** Drawn after the water's surface sheet. */
const haloRenderOrder = 1;

/**
 * The water about the stacks: one instanced disc each, over the water
 * level, `halo.reach` times the stack's footprint. A pale shoal glow fades
 * out across it, its `strength` per stack; a stack that breaks the surface
 * adds a thin ring of foam at its footprint's edge, broken a little round
 * its bearing so it never reads as a drawn circle.
 */
function haloMesh(
  stacks: readonly SeaStack[],
  tops: readonly number[],
  spread: number,
  settings: SeaStacksMeshSettings["halo"]
): { dispose: () => void; mesh: InstancedMesh } {
  const geometry = new PlaneGeometry(2, 2);
  const kinds = new Float32Array(stacks.length * 3);
  const matrix = new Matrix4();
  const flat = new Quaternion();
  const matrices = stacks.map((stack, index) => {
    const top = tops[index] ?? 0;
    const breaks = top > geologyLevels.waterLevel ? 1 : 0;
    const depth = nominalDepth(top);
    const shoal =
      settings.shoal.strength *
      (breaks
        ? 1
        : 1 -
          (1 - settings.shoal.deep) *
            Math.min(1, depth / Math.max(settings.shoal.depth, 1e-6)));
    kinds.set([breaks, shoal, unit(`${stack.id}:foam`)], index * 3);
    const reach = stack.radius * spread * settings.reach;
    return matrix
      .clone()
      .compose(
        new Vector3(stack.x, -stack.y, haloLift),
        flat,
        new Vector3(reach, reach, 1)
      );
  });
  geometry.setAttribute("haloKind", new InstancedBufferAttribute(kinds, 3));
  const kind = attribute<"vec3">("haloKind", "vec3");
  const centred = uv().sub(0.5).mul(2);
  const r = centred.length();
  const edge = 1 / settings.reach;
  const bearing = atan(centred.y, centred.x);
  // An uneven edge: a few waves round the bearing, seeded per stack, so
  // neither the wash nor the glow ever reads as a drawn circle.
  const seed = kind.z.mul(40);
  const wobble = sin(bearing.mul(3).add(seed))
    .mul(0.5)
    .add(sin(bearing.mul(5).sub(seed.mul(1.7))).mul(0.3))
    .add(sin(bearing.mul(9).add(seed.mul(2.3))).mul(0.2));
  const reach = r.div(wobble.mul(0.14).add(1));
  const foam = float(1)
    .sub(smoothstep(edge * 0.7, edge + settings.foam.width, reach))
    .mul(kind.x)
    .mul(settings.foam.strength);
  const shoal = float(1)
    .sub(smoothstep(edge * 0.6, 1, reach))
    .pow(1.4)
    .mul(kind.y);
  const material = new MeshBasicNodeMaterial({
    depthWrite: false,
    side: DoubleSide,
    transparent: true,
  });
  material.colorNode = mix(
    color(settings.shoal.colour),
    color(settings.foam.colour),
    foam.div(max(foam.add(shoal), 1e-4))
  );
  material.opacityNode = foam.add(shoal.mul(foam.oneMinus())).clamp(0, 1);
  const mesh = new InstancedMesh(geometry, material, stacks.length);
  mesh.name = "sea-stack-halos";
  mesh.renderOrder = haloRenderOrder;
  for (const [index, each] of matrices.entries()) {
    mesh.setMatrixAt(index, each);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (stacks.length > 0) {
    mesh.computeBoundingSphere();
  }
  return {
    dispose() {
      geometry.dispose();
      material.dispose();
    },
    mesh,
  };
}

/** An instance's transform: its foot on the seabed, scaled to its stack, turned and leaning seaward. */
function instanceMatrix(
  stack: SeaStack,
  base: number,
  top: number,
  exaggeration: number,
  target: Matrix4
): Matrix4 {
  const rotation = new Quaternion().setFromAxisAngle(
    up,
    2 * Math.PI * unit(`${stack.id}:spin`)
  );
  if (stack.lean) {
    const toward = new Vector3(
      Math.cos(stack.lean.bearing),
      -Math.sin(stack.lean.bearing),
      0
    );
    const axis = new Vector3().crossVectors(up, toward).normalize();
    rotation.premultiply(
      new Quaternion().setFromAxisAngle(axis, stack.lean.angle)
    );
  }
  return target.compose(
    new Vector3(stack.x, -stack.y, base * exaggeration),
    rotation,
    new Vector3(stack.radius, stack.radius, (top - base) * exaggeration)
  );
}

/**
 * The stacks as one instanced mesh in the geology preview's space: x and
 * map y turned over, z the elevation times `exaggeration`. Each stack's foot
 * is on the seabed `sample` reads at its centre, and its top at its own
 * elevation, or `minimumRise` over the seabed where that is higher.
 */
export function createSeaStacksMesh(
  stacks: readonly SeaStack[],
  options: SeaStacksMeshOptions
): { dispose: () => void; mesh: InstancedMesh } {
  const {
    exaggeration = 14,
    light = defaultTerrainLightSettings,
    sample,
    settings = defaultSeaStacksMeshSettings,
  } = options;
  const geometry = seaStackGeometry(settings.occlusion);
  const spans = new Float32Array(stacks.length * 2);
  const tints = new Float32Array(stacks.length * 3);
  const tint = new Color();
  const tops: number[] = [];
  const matrices = stacks.map((stack, index) => {
    const base = sample(stack.x, stack.y);
    const lifted =
      stack.height > geologyLevels.waterLevel
        ? stack.height * settings.rise
        : stack.height;
    const top = Math.max(lifted, base + settings.minimumRise);
    tops.push(top);
    spans.set([base, top], index * 2);
    tint.set(islandPigment({ id: stack.islandId }));
    tints.set([tint.r, tint.g, tint.b], index * 3);
    return instanceMatrix(
      { ...stack, radius: stack.radius * settings.spread },
      base,
      top,
      exaggeration,
      new Matrix4()
    );
  });
  geometry.setAttribute("stackSpan", new InstancedBufferAttribute(spans, 2));
  geometry.setAttribute("stackTint", new InstancedBufferAttribute(tints, 3));
  const rock = stackMaterial(settings, light);
  const mesh = new InstancedMesh(geometry, rock.material, stacks.length);
  mesh.name = "sea-stacks";
  for (const [index, matrix] of matrices.entries()) {
    mesh.setMatrixAt(index, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (stacks.length > 0) {
    mesh.computeBoundingSphere();
  }
  // The halos ride with the rock, so whoever shows the stacks shows them.
  const halos = haloMesh(stacks, tops, settings.spread, settings.halo);
  mesh.add(halos.mesh);
  return {
    dispose() {
      mesh.dispose();
      geometry.dispose();
      rock.dispose();
      halos.mesh.dispose();
      halos.dispose();
    },
    mesh,
  };
}
