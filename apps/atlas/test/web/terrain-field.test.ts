import { Mesh, MeshBasicMaterial, Raycaster, Vector3 } from "three";
import { expect, it } from "vitest";
import { ridgeProfile } from "../../src/web/codex/bindings";
import {
  createLabelProjector,
  elevatedLabel,
} from "../../src/web/scene/lettering";
import { paperThickness } from "../../src/web/scene/paper-material";
import { terrainGeometry } from "../../src/web/scene/terrain";
import { createTerrainField } from "../../src/web/scene/terrain-field";
import { createTerrainPicker } from "../../src/web/scene/terrain-picking";
import type { AtlasFile, Territory } from "../../src/web/types";

const file: AtlasFile = {
  directory: "src",
  id: "shared",
  incoming: 20,
  kind: "source",
  outgoing: 0,
  path: "src/shared.ts",
  x: 0,
  y: 0,
};
const territory: Territory = {
  analyzed: true,
  coast: [
    [
      [
        [-50, -50],
        [50, -50],
        [50, 50],
        [-50, 50],
        [-50, -50],
      ],
    ],
  ],
  color: "#fff",
  files: [file],
  hills: [],
  id: "example",
  label: "Example",
  neighborhoods: [],
  radius: 50,
  shallows: [],
  x: 0,
  y: 0,
};

it("gives a depended-on file a stronger crest without lifting the coast or moving files", () => {
  const before = structuredClone(territory);
  const terrain = createTerrainField(territory);
  const quiet = createTerrainField({
    ...territory,
    files: [{ ...file, incoming: 0 }],
  });
  expect(terrain.sample(0, 0).elevation).toBeGreaterThan(
    quiet.sample(0, 0).elevation * 3
  );
  expect(terrain.sample(0, 0).elevation).toBeGreaterThan(
    terrain.sample(5, 0).elevation
  );
  expect(terrain.sample(40, 0).elevation).toBe(0);
  expect(terrain.sample(50, 0).elevation).toBe(0);
  expect(territory).toEqual(before);
});

it("raises label anchors without distorting their type or click bounds", () => {
  const label = {
    file,
    font: "10px Georgia",
    height: 10,
    territory,
    text: "shared.ts",
    width: 48,
    x: 0,
    y: -4,
  };
  const projected = elevatedLabel(label, 6, 0.7);
  expect(projected.y).toBeCloseTo(label.y - 6 * Math.tan(0.7));
  expect(projected).toMatchObject({
    font: label.font,
    height: 10,
    width: 48,
    x: 0,
  });
  expect(label.y).toBe(-4);
});

it("darkens the saddle between two crests while keeping their summits clear", () => {
  const pair = {
    ...territory,
    files: [
      { ...file, id: "west", x: -8 },
      { ...file, id: "east", x: 8 },
    ],
  };
  const [coast] = pair.coast;
  if (!coast) {
    throw new Error("Missing fixture coast");
  }
  const geometry = terrainGeometry(pair, coast, 100, 100);
  const positions = geometry.getAttribute("position");
  const shade = geometry.getAttribute("occlusion");
  const at = (x: number) => {
    let nearest = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < positions.count; index += 1) {
      const next = Math.hypot(positions.getX(index) - x, positions.getY(index));
      if (next < distance) {
        nearest = index;
        distance = next;
      }
    }
    return shade.getX(nearest);
  };
  expect(at(0)).toBeGreaterThan(0.2);
  expect(at(-8)).toBeLessThan(0.05);
  expect(at(8)).toBeLessThan(0.05);
  expect(shade.count).toBe(positions.count);
  geometry.dispose();
});

it("finds the same terrain triangle as a full raycast, including coast misses", () => {
  const [coast] = territory.coast;
  if (!coast) {
    throw new Error("Missing fixture coast");
  }
  const geometry = terrainGeometry(territory, coast, 100, 100);
  const material = new MeshBasicMaterial();
  const mesh = new Mesh(geometry, material);
  const pick = createTerrainPicker([geometry], 0.7);
  const direction = new Vector3(0, Math.sin(0.7), -Math.cos(0.7));
  for (let x = -55; x < 55; x += 7) {
    for (let y = -55; y < 55; y += 11) {
      const ground = new Vector3(x, y, paperThickness);
      const ray = new Raycaster(
        ground.clone().addScaledVector(direction, -100),
        direction
      );
      const [expected] = ray.intersectObject(mesh);
      const hit = pick(ground);
      expect(Boolean(hit)).toBe(Boolean(expected));
      if (hit && expected) {
        expect(hit.distanceTo(expected.point)).toBeLessThan(1e-6);
      }
    }
  }
  geometry.dispose();
  material.dispose();
});

it("samples a file label once across camera changes and refreshes after terrain changes", () => {
  let samples = 0;
  const field = (elevation: number) => ({
    sample: () => {
      samples += 1;
      return { elevation, mineral: 0 };
    },
  });
  let active = field(6);
  const project = createLabelProjector(() => active, 0.7);
  const label = {
    file,
    font: "10px Georgia",
    height: 10,
    territory,
    text: "shared.ts",
    width: 48,
    x: 0,
    y: -4,
  };
  for (let index = 0; index < 100; index += 1) {
    project({ ...label, y: -index });
  }
  expect(samples).toBe(1);
  active = field(3);
  expect(project(label).y).toBeCloseTo(label.y - 3 * Math.tan(0.7));
  expect(samples).toBe(2);
  project({ ...label, file: { ...file, x: 4 } });
  expect(samples).toBe(3);
});

it("rounds the crest and foot without flattening the elevation signal", () => {
  const epsilon = 0.000_01;
  expect(ridgeProfile(0, 1, 6)).toBe(6);
  expect(
    (ridgeProfile(0, 1, 1) - ridgeProfile(epsilon, 1, 1)) / epsilon
  ).toBeLessThan(0.001);
  expect(ridgeProfile(1 - epsilon, 1, 1) / epsilon).toBeLessThan(0.001);
  expect(ridgeProfile(1, 1, 6)).toBe(0);
});

it("preserves the terrain across ridge overlaps, empty ground and negative coordinates", () => {
  const clustered = {
    ...territory,
    files: Array.from({ length: 12 }, (_, index) => ({
      ...file,
      id: `file-${index}`,
      incoming: index * 3,
      x: (index % 4) * 17 - 28,
      y: Math.floor(index / 4) * 13 - 21,
    })),
  };
  const field = createTerrainField(clustered);
  const samples: number[] = [];
  for (let y = -60; y <= 60; y += 13) {
    for (let x = -60; x <= 60; x += 11) {
      samples.push(Number(field.sample(x, y).elevation.toFixed(8)));
    }
  }
  expect(samples).toMatchSnapshot();
});
