import { Mesh, MeshBasicMaterial, Raycaster, Vector3 } from "three";
import { expect, it } from "vitest";
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

it("gives a neighborhood shared level ground without separate file summits", () => {
  const grouped = {
    ...territory,
    files: [
      { ...file, id: "a", x: -12 },
      { ...file, id: "b", x: 12 },
    ],
    neighborhoods: [
      {
        id: "group",
        imports: 20,
        label: "Shared",
        members: ["a", "b"],
        sharedConcepts: 0,
      },
    ],
  };
  const before = structuredClone(grouped);
  const terrain = createTerrainField(grouped);
  const quiet = createTerrainField({
    ...grouped,
    files: grouped.files.map((member) => ({ ...member, incoming: 0 })),
  });
  expect(terrain.sample(-12, 0).elevation).toBeCloseTo(
    terrain.sample(12, 0).elevation,
    4
  );
  expect(terrain.sample(0, 0).elevation).toBeCloseTo(
    terrain.sample(12, 0).elevation,
    4
  );
  expect(terrain.sample(0, 0).elevation).toBeGreaterThan(
    quiet.sample(0, 0).elevation
  );
  expect(terrain.sample(50, 0).elevation).toBeLessThan(0.05);
  expect(terrain.sample(60, 0).elevation).toBe(0);
  expect(grouped).toEqual(before);
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

it("keeps ungrouped files on low ground regardless of their individual import counts", () => {
  const terrain = createTerrainField(territory);
  expect(terrain.sample(0, 0).elevation).toBeCloseTo(0.6);
  expect(terrain.sample(12, 0).elevation).toBeCloseTo(0.6);
  expect(terrain.sample(0, 0)).toEqual(
    createTerrainField({
      ...territory,
      files: [{ ...file, incoming: 0 }],
    }).sample(0, 0)
  );
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
