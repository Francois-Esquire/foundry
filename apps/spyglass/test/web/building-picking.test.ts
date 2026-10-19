import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Vector3,
} from "three";
import { expect, it } from "vitest";
import { paperThickness } from "../../src/web/data/bindings";
import { buildingTop, layoutBuildings } from "../../src/web/layout/buildings";
import { renderingStudy } from "../../src/web/layout/rendering-study";
import { createArchitectureLayer } from "../../src/web/scene/architecture-layer";
import { createArchitecturePicker } from "../../src/web/scene/architecture-picking";
import { createViewState } from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { dioramaTilt, type InkView } from "../../src/web/view/chart-view";

const view: InkView = {
  height: 270,
  pixelsPerUnit: 4,
  presentation: 1,
  tilt: dioramaTilt,
  width: 360,
  x: 0,
  y: 0,
};
const onPaper = (x: number, y: number, z: number, tilt: number) =>
  new Vector3(x, y + (z - paperThickness) * Math.tan(tilt), paperThickness);

it("picks the actual gable ridge and front wall at changing camera tilts", () => {
  const data = renderingStudy();
  const layer = createArchitectureLayer(data);
  const state = createViewState(data, {
    ...defaultChartSettings,
    presentation: 1,
  });
  const [building] = layoutBuildings(data);
  if (!building) {
    throw new Error("Study building is required.");
  }
  for (const presentation of [0.3, 0.7, 1]) {
    const tilt = presentation * dioramaTilt;
    const current = { ...view, presentation, tilt };
    layer.update?.(current, state, 0);
    const top = buildingTop(building, presentation);
    const ridge = onPaper(building.x, -building.y, top, tilt);
    const hit = layer.pick(ridge, current);
    expect(hit?.file.id).toBe(building.file.id);
    expect(hit?.point.z).toBeCloseTo(top);
    if (presentation < 0.5) {
      // At a shallow angle the roof overhang correctly occludes the short wall.
      continue;
    }
    const wallZ =
      building.base + building.footing + building.height * presentation * 0.5;
    const wallY = -building.y - building.width / 2;
    const wall = layer.pick(onPaper(building.x, wallY, wallZ, tilt), current);
    expect(wall?.file.id).toBe(building.file.id);
    expect(wall?.point.z).toBeCloseTo(wallZ);
    expect(wall?.point.y).toBeCloseTo(wallY);
  }
  layer.dispose();
});

it("maps compacted landmark instances to their files and resolves label height before drawing", () => {
  const data = renderingStudy();
  data.routes.push({
    consumerFiles: [],
    from: "other",
    sharedConcepts: 0,
    supplierFiles: ["study/wind.ts"],
    to: "harbor",
    weight: 1,
  });
  const layer = createArchitectureLayer(data);
  const state = createViewState(data, {
    ...defaultChartSettings,
    presentation: 1,
  });
  const landmark = layoutBuildings(data).find((building) => building.landmark);
  if (!landmark) {
    throw new Error("The study needs an externally consumed landmark.");
  }
  expect(layer.roofHeight(landmark.file.id, view, data)).toBe(
    buildingTop(landmark, 1)
  );
  layer.update?.(view, state, 0);
  const point = onPaper(
    landmark.x + 0.3,
    -landmark.y,
    buildingTop(landmark, 1) - 0.5,
    dioramaTilt
  );
  expect(layer.pick(point, view)?.file.id).toBe("study/wind.ts");
  const relaid = {
    ...data,
    territories: data.territories.map((territory) => ({
      ...territory,
      files: territory.files.map((file) =>
        file.id === landmark.file.id ? { ...file, incoming: 20 } : file
      ),
    })),
  };
  const changed = layoutBuildings(relaid).find(
    (building) => building.file.id === landmark.file.id
  );
  expect(changed).toBeDefined();
  expect(layer.roofHeight(landmark.file.id, view, relaid)).toBe(
    changed && buildingTop(changed, 1)
  );
  layer.dispose();
});

it("never hits hidden, subpixel or flattened buildings", () => {
  const data = renderingStudy();
  const layer = createArchitectureLayer(data);
  const state = createViewState(data, {
    ...defaultChartSettings,
    presentation: 1,
  });
  const [building] = layoutBuildings(data);
  if (!(building && layer.group)) {
    throw new Error("Study layer is required.");
  }
  const point = onPaper(
    building.x,
    -building.y,
    buildingTop(building, 1),
    dioramaTilt
  );
  layer.update?.(view, state, 0);
  expect(layer.pick(point, view)?.file.id).toBe(building.file.id);
  layer.group.visible = false;
  expect(layer.pick(point, view)).toBeNull();
  expect(layer.roofHeight(building.file.id, view, data)).toBeUndefined();
  layer.group.visible = true;
  layer.update?.({ ...view, pixelsPerUnit: 0.1 }, state, 0);
  expect(layer.pick(point, view)).toBeNull();
  expect(
    layer.roofHeight(building.file.id, { ...view, pixelsPerUnit: 0.1 }, data)
  ).toBeUndefined();
  layer.update?.({ ...view, presentation: 0 }, state, 0);
  expect(layer.pick(point, view)).toBeNull();
  expect(
    layer.roofHeight(building.file.id, { ...view, presentation: 0 }, data)
  ).toBeUndefined();
  layer.dispose();
});

it("returns the frontmost actual instance when projected building silhouettes overlap", () => {
  const buildings = layoutBuildings(renderingStudy()).slice(0, 2);
  const group = new Group();
  const geometry = new BoxGeometry(5, 5, 5);
  const material = new MeshBasicMaterial();
  const mesh = new InstancedMesh(geometry, material, 2);
  mesh.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, 10));
  mesh.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, 20));
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  group.add(mesh);
  const pick = createArchitecturePicker(
    group,
    () => new Map([[mesh, buildings]])
  );
  const hit = pick(new Vector3(0, 0, paperThickness), { ...view, tilt: 0 });
  expect(hit?.file).toBe(buildings[1]?.file);
  expect(hit?.point.z).toBeCloseTo(22.5);
  mesh.count = 1;
  expect(
    pick(new Vector3(0, 0, paperThickness), { ...view, tilt: 0 })?.file
  ).toBe(buildings[0]?.file);
  mesh.dispose();
  geometry.dispose();
  material.dispose();
});
