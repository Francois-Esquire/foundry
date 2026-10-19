import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from "three";
import {
  attribute,
  color,
  float,
  mix,
  normalWorld,
  positionGeometry,
  smoothstep,
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
 * Sea stacks drawn as one instanced mesh of a low, faceted, terraced rock
 * pillar. Each instance stands on the seabed under it and rises to its
 * stack's top; under water the rock is dark and wet and seen through its
 * column of water as the terrain is, above it pale weathered rock with
 * tufts in its island's pigment on the ledges facing the sky. The rock is
 * lit as the terrain is, with its foot and the inner corner of each ledge
 * baked darker.
 */
export const defaultSeaStacksMeshSettings = {
  colours: {
    /** Weathered rock above the splash zone, toward the beach's pale sand. */
    dry: "#d6ccb4",
    /** Wet rock below the water and in the splash zone, toward the seabed's rock. */
    wet: "#4c4740",
  },
  /** Tufts on ledges facing the sky, by the world normal's upward share, and how much of the pigment shows. */
  grass: { facing: { from: 0.55, to: 0.85 }, share: 0.8 },
  /** Elevation each stack stands at least over the seabed under it, so none is buried. */
  minimumRise: 0.06,
  /**
   * The share of the sky the pillar's creases lose: its foot against the
   * seabed and the inner corner of each ledge.
   */
  occlusion: { crease: 0.3, foot: 0.55 },
  /** Elevation above the water level the splash zone keeps wet. */
  splash: 0.012,
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

/** Each corner's share of a tier's radius: a slightly irregular heptagon. */
const corners = [1, 0.84, 1.07, 0.9, 1.03, 0.81, 0.96] as const;

/**
 * The pillar's profile, base to top, as a share of its height and of its
 * radius: a skirt buried below the seabed, then three tiers, each stepped in
 * at a ledge, and a bevelled cap. `hollow` is how much of a crease each ring
 * sits in: the foot against the seabed, or a ledge's inner corner.
 */
const profile = [
  { hollow: "foot", radius: 1.12, z: -0.2 },
  { hollow: "foot", radius: 1, z: 0 },
  { hollow: "", radius: 0.9, z: 0.34 },
  { hollow: "crease", radius: 0.72, z: 0.38 },
  { hollow: "", radius: 0.64, z: 0.66 },
  { hollow: "crease", radius: 0.48, z: 0.7 },
  { hollow: "", radius: 0.42, z: 0.92 },
  { hollow: "", radius: 0.3, z: 1 },
] as const;

/** Radians each ring of the profile turns from the one below, so the facets do not line up. */
const twist = 0.11;

/**
 * The unit pillar: radius 1 at its foot, the seabed at z 0 and its top at
 * z 1, unindexed so each facet is shaded flat. Each vertex carries the
 * share of the sky it sees, `occlusion`, darker at the foot and in each
 * ledge's inner corner.
 */
export function seaStackGeometry(
  occlusion: SeaStacksMeshSettings["occlusion"] = defaultSeaStacksMeshSettings.occlusion
): BufferGeometry {
  const sky = { "": 1, crease: 1 - occlusion.crease, foot: 1 - occlusion.foot };
  const rings = profile.map(({ hollow, radius, z }, tier) =>
    corners.map((share, corner) => {
      const angle = (2 * Math.PI * corner) / corners.length + twist * tier;
      return [
        Math.cos(angle) * radius * share,
        Math.sin(angle) * radius * share,
        z,
        sky[hollow],
      ] as const;
    })
  );
  const positions: number[] = [];
  const skies: number[] = [];
  const triangle = (...points: (readonly number[])[]) => {
    for (const [x = 0, y = 0, z = 0, open = 1] of points) {
      positions.push(x, y, z);
      skies.push(open);
    }
  };
  for (let tier = 1; tier < rings.length; tier += 1) {
    const below = rings[tier - 1] ?? [];
    const above = rings[tier] ?? [];
    for (let corner = 0; corner < corners.length; corner += 1) {
      const next = (corner + 1) % corners.length;
      const [a, b, c, d] = [
        below[corner],
        below[next],
        above[next],
        above[corner],
      ];
      if (a && b && c && d) {
        triangle(a, b, c);
        triangle(a, c, d);
      }
    }
  }
  const crown = [0, 0, 1.02, 1] as const;
  const top = rings.at(-1) ?? [];
  for (let corner = 0; corner < top.length; corner += 1) {
    const a = top[corner];
    const b = top[(corner + 1) % top.length];
    if (a && b) {
      triangle(a, b, crown);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("occlusion", new Float32BufferAttribute(skies, 1));
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
  const elevation = span.x.add(positionGeometry.z.mul(span.y.sub(span.x)));
  const normal = normalWorld.normalize();
  const rock = mix(
    color(settings.colours.wet),
    color(settings.colours.dry),
    smoothstep(0, settings.splash, elevation)
  );
  const tufts = smoothstep(
    settings.grass.facing.from,
    settings.grass.facing.to,
    normal.z
  )
    .mul(smoothstep(settings.splash, 2 * settings.splash, elevation))
    .mul(settings.grass.share);
  const albedo = mix(rock, tint, tufts);
  const lit = terrainLightNode({
    normal,
    relief: 1,
    settings: light,
    sky: occlusion,
    sun: float(1),
  });
  const optics = waterOpticsNode({
    depth: depthNode(elevation),
    seabedColour: albedo.mul(lit),
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
  const matrices = stacks.map((stack, index) => {
    const base = sample(stack.x, stack.y);
    const top = Math.max(stack.height, base + settings.minimumRise);
    spans.set([base, top], index * 2);
    tint.set(islandPigment({ id: stack.islandId }));
    tints.set([tint.r, tint.g, tint.b], index * 3);
    return instanceMatrix(stack, base, top, exaggeration, new Matrix4());
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
  return {
    dispose() {
      mesh.dispose();
      geometry.dispose();
      rock.dispose();
    },
    mesh,
  };
}
