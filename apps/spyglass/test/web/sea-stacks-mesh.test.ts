import { InstancedBufferAttribute, Matrix4, Quaternion, Vector3 } from "three";
import { expect, it, vi } from "vitest";
import type { SeaStack } from "../../src/lib/visualization/sea-stacks";
import {
  createSeaStacksMesh,
  defaultSeaStacksMeshSettings,
  seaStackGeometry,
} from "../../src/web/scene/sea-stacks-mesh";

const stacks: SeaStack[] = [
  {
    height: 0.15,
    id: "stack:a+dependency:one",
    islandId: "a",
    members: ["a", "dependency:one"],
    radius: 3,
    x: 40,
    y: 10,
  },
  {
    height: -0.03,
    id: "stack:a+dependency:two",
    islandId: "a",
    lean: { angle: 0.1, bearing: Math.PI / 2 },
    members: ["a", "dependency:two"],
    radius: 1.5,
    x: -30,
    y: 25,
  },
  {
    height: -0.2,
    id: "stack:b+dependency:three",
    islandId: "b",
    members: ["b", "dependency:three"],
    radius: 2,
    x: 0,
    y: -50,
  },
];

it("builds one instance per stack, each foot on the seabed and its top at the stack's elevation", () => {
  const seabed = -0.18;
  const { dispose, mesh } = createSeaStacksMesh(stacks, {
    exaggeration: 14,
    sample: () => seabed,
  });
  expect(mesh.count).toBe(stacks.length);
  expect(mesh.instanceMatrix.count).toBe(stacks.length);
  const matrix = new Matrix4();
  const position = new Vector3();
  const scale = new Vector3();
  mesh.getMatrixAt(0, matrix);
  matrix.decompose(position, new Quaternion(), scale);
  expect(position.x).toBeCloseTo(40, 6);
  expect(position.y).toBeCloseTo(-10, 6);
  expect(position.z).toBeCloseTo(seabed * 14, 6);
  expect(scale.z).toBeCloseTo((0.15 - seabed) * 14, 5);
  expect(scale.x).toBeCloseTo(3, 5);
  const spans = mesh.geometry.getAttribute("stackSpan");
  expect(spans).toBeInstanceOf(InstancedBufferAttribute);
  expect(spans.count).toBe(stacks.length);
  expect([spans.getX(0), spans.getY(0)]).toEqual([
    Math.fround(seabed),
    Math.fround(0.15),
  ]);
  // A stack whose top is under the seabed still stands its least rise over it.
  expect(spans.getY(2)).toBeCloseTo(
    seabed + defaultSeaStacksMeshSettings.minimumRise,
    6
  );
  // The leaning stack's top is offset toward its bearing: down the chart is world -y.
  mesh.getMatrixAt(1, matrix);
  const top = new Vector3(0, 0, 1).applyMatrix4(matrix);
  const foot = new Vector3(0, 0, 0).applyMatrix4(matrix);
  expect(top.y).toBeLessThan(foot.y);
  expect(mesh.geometry.getAttribute("stackTint").count).toBe(stacks.length);
  dispose();
});

it("builds an empty mesh for no stacks", () => {
  const { dispose, mesh } = createSeaStacksMesh([], { sample: () => -0.5 });
  expect(mesh.count).toBe(0);
  dispose();
});

it("disposes its geometry, material and instances", () => {
  const { dispose, mesh } = createSeaStacksMesh(stacks, { sample: () => -0.3 });
  const geometry = vi.fn();
  const material = vi.fn();
  const instances = vi.fn();
  mesh.geometry.addEventListener("dispose", geometry);
  const [first] = [mesh.material].flat();
  first?.addEventListener("dispose", material);
  mesh.addEventListener("dispose", instances);
  dispose();
  expect(geometry).toHaveBeenCalledOnce();
  expect(material).toHaveBeenCalledOnce();
  expect(instances).toHaveBeenCalledOnce();
});

it("shapes a unit pillar: its foot at radius about 1, its top at 1, faceted", () => {
  const geometry = seaStackGeometry();
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  expect(box?.max.z).toBeCloseTo(1.02, 6);
  expect(box?.min.z).toBeLessThan(0);
  expect(box?.max.x).toBeGreaterThan(0.9);
  expect(box?.max.x).toBeLessThan(1.3);
  expect(geometry.index).toBeNull();
  expect(geometry.getAttribute("normal").count).toBe(
    geometry.getAttribute("position").count
  );
  geometry.dispose();
});
