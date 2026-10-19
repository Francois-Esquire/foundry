import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
} from "three";
import { afterAll, afterEach, expect, it } from "vitest";
import { paperThickness } from "../../src/web/data/bindings";
import { createTerrainPicker } from "../../src/web/interaction/terrain-picking";
import { chartTilt } from "../../src/web/view/chart-view";

const geometries: BufferGeometry[] = [];
const material = new MeshBasicMaterial();
afterAll(() => material.dispose());
afterEach(() => {
  for (const geometry of geometries.splice(0)) {
    geometry.dispose();
  }
});

function triangle(vertices: number[], indexed = true): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
  if (indexed) {
    geometry.setIndex([0, 1, 2]);
  }
  geometries.push(geometry);
  return geometry;
}

it.each([true, false])(
  "picks elevated terrain at the original chart angle with indexed=%s geometry",
  (indexed) => {
    const geometry = triangle([-12, -12, 40, 12, -12, 40, 0, 12, 40], indexed);
    const pick = createTerrainPicker([geometry], chartTilt);
    const ground = new Vector3(
      0,
      (40 - paperThickness) * Math.tan(chartTilt),
      paperThickness
    );
    const hit = pick(ground);
    expect(hit?.x).toBeCloseTo(0);
    expect(hit?.y).toBeCloseTo(0);
    expect(hit?.z).toBeCloseTo(40);
    expect(pick(new Vector3(0, 0, paperThickness))).toBeUndefined();
  }
);

it("matches full raycasting through overlapping elevated, steep, and submerged surfaces", () => {
  const surfaces = [
    triangle([-20, -20, 4, 20, -20, 4, 0, 20, 4]),
    triangle([-12, -12, 24, 12, -12, 24, 0, 12, 24], false),
    triangle([-12, 0, 0, 12, 0, 0, 0, -10, 30]),
    triangle([-20, -20, -15, 20, -20, -15, 0, 20, -15]),
  ];
  const meshes = surfaces.map((geometry) => new Mesh(geometry, material));
  const pick = createTerrainPicker(surfaces, chartTilt);
  const direction = new Vector3(0, Math.sin(chartTilt), -Math.cos(chartTilt));
  // Offset samples avoid raycast roundoff at exact triangle vertices.
  for (let x = -23.63; x <= 24; x += 3) {
    for (let y = -47.77; y <= 64; y += 4) {
      const ground = new Vector3(x, y, paperThickness);
      const ray = new Raycaster(
        ground.clone().addScaledVector(direction, -1000),
        direction
      );
      const expected = ray.intersectObjects(meshes)[0]?.point;
      const actual = pick(ground);
      expect(Boolean(actual)).toBe(Boolean(expected));
      if (actual && expected) {
        expect(actual.distanceTo(expected)).toBeLessThan(1e-6);
      }
    }
  }
});
