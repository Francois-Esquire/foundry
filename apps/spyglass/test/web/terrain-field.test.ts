import { Mesh, MeshBasicMaterial, Raycaster, Vector3 } from "three";
import { expect, it } from "vitest";
import { islandPlinth, paperThickness } from "../../src/web/data/bindings";
import type { SpyglassFile, Territory } from "../../src/web/data/types";
import { createTerrainField } from "../../src/web/layout/terrain-field";
import {
  createLabelProjector,
  elevatedLabel,
} from "../../src/web/scene/lettering";
import { terrainGeometry } from "../../src/web/scene/terrain";
import { createTerrainPicker } from "../../src/web/scene/terrain-picking";

const file: SpyglassFile = {
  directory: "src",
  highFanIn: false,
  id: "shared",
  incoming: 20,
  internalFanIn: 0,
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
  fileRoles: undefined,
  files: [file],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "example",
  label: "Example",
  radius: 50,
  responsibilityGroups: undefined,
  shallows: [],
  x: 0,
  y: 0,
};

const quietFiles = Array.from({ length: 40 }, (_, index) => ({
  ...file,
  id: `quiet-${index}`,
  incoming: 30,
  internalFanIn: index % 3,
  x: -40 + (index % 8) * 11,
  y: -40 + Math.floor(index / 8) * 20,
}));
const summit: SpyglassFile = { ...file, highFanIn: true, internalFanIn: 20 };

it("raises a summit only for a high fan-in file and leaves the rest as lowland, however many imports reach them", () => {
  const island = {
    ...territory,
    files: [...quietFiles, summit],
    highFanInCutoff: 3,
  };
  const before = structuredClone(island);
  const terrain = createTerrainField(island);
  const lowland = createTerrainField({
    ...island,
    files: island.files.map((member) => ({ ...member, highFanIn: false })),
  });
  expect(
    terrain.sample(0, 0).elevation - lowland.sample(0, 0).elevation
  ).toBeGreaterThan(2);
  // Ordinary files never raise their own ground.
  expect(terrain.sample(-40, 40).elevation).toBeCloseTo(
    lowland.sample(-40, 40).elevation,
    4
  );
  expect(terrain.sample(50, 0).elevation).toBeLessThan(0.05);
  expect(terrain.sample(60, 0).elevation).toBe(0);
  expect(island).toEqual(before);
});

it("rises gently and continuously from the beach without levelling into a table", () => {
  const terrain = createTerrainField({ ...territory, files: quietFiles });
  const profile = [48, 45, 40, 30, 20, 10, 0].map(
    (x) => terrain.sample(x, 0).elevation
  );
  for (let i = 1; i < profile.length; i += 1) {
    expect(profile[i]).toBeGreaterThan(profile[i - 1] ?? 0);
  }
  expect((profile[6] ?? 0) - (profile[4] ?? 0)).toBeGreaterThan(0.1);
  expect(profile[6]).toBeLessThan(1.9);
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
  expect(project(label).y).toBeCloseTo(
    label.y - (islandPlinth + 3) * Math.tan(0.7)
  );
  expect(samples).toBe(2);
  project({ ...label, file: { ...file, x: 4 } });
  expect(samples).toBe(3);
});
