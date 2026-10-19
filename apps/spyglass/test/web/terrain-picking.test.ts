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
import { dioramaTilt } from "../../src/web/view/chart-view";

const geometries: BufferGeometry[] = [];
const material = new MeshBasicMaterial();
afterAll(() => material.dispose());
afterEach(() => {
  for (const geometry of geometries.splice(0)) {
    geometry.dispose();
  }
});

/** Real front-facing triangles, with enough elevation to cross several spatial bins. */
function triangle(vertices: number[], indexed = true): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
  if (indexed) {
    geometry.setIndex([0, 1, 2]);
  }
  geometries.push(geometry);
  return geometry;
}

function rayHit(meshes: Mesh[], ground: Vector3, tilt: number) {
  const direction = new Vector3(0, Math.sin(tilt), -Math.cos(tilt));
  const ray = new Raycaster(
    ground.clone().addScaledVector(direction, -1000),
    direction
  );
  return ray.intersectObjects(meshes)[0]?.point;
}

it.each([true, false])(
  "keeps elevated terrain pickable across the whole camera journey with indexed=%s geometry",
  (indexed) => {
    const geometry = triangle([-12, -12, 40, 12, -12, 40, 0, 12, 40], indexed);
    let tilt = 0;
    const pick = createTerrainPicker([geometry], () => tilt);
    for (const angle of [
      0,
      dioramaTilt * 0.25,
      dioramaTilt,
      dioramaTilt * 0.5,
      0,
    ]) {
      tilt = angle;
      const ground = new Vector3(
        0,
        (40 - paperThickness) * Math.tan(tilt),
        paperThickness
      );
      const hit = pick(ground);
      expect(hit?.x).toBeCloseTo(0);
      expect(hit?.y).toBeCloseTo(0);
      expect(hit?.z).toBeCloseTo(40);
      // The same old screen position must not hit a now-distant elevated triangle.
      if (tilt === dioramaTilt) {
        expect(pick(new Vector3(0, 0, paperThickness))).toBeUndefined();
      }
    }
  }
);

it("matches full raycasting through multiple overlapping surfaces as tilt changes", () => {
  const surfaces = [
    triangle([-20, -20, 4, 20, -20, 4, 0, 20, 4]),
    triangle([-12, -12, 24, 12, -12, 24, 0, 12, 24], false),
    // A steep reverse-facing slope becomes visible only when the camera tilts.
    triangle([-12, 0, 0, 12, 0, 0, 0, -10, 30]),
    // Submerged geometry moves in the opposite direction across spatial bins.
    triangle([-20, -20, -15, 20, -20, -15, 0, 20, -15]),
  ];
  const meshes = surfaces.map((geometry) => new Mesh(geometry, material));
  let tilt = 0;
  const pick = createTerrainPicker(surfaces, () => tilt);
  for (const angle of [
    0,
    dioramaTilt * 0.25,
    dioramaTilt * 0.5,
    dioramaTilt,
    0,
  ]) {
    tilt = angle;
    // Offset samples avoid Three raycast roundoff at exact triangle vertices.
    for (let x = -23.63; x <= 24; x += 3) {
      for (let y = -47.77; y <= 64; y += 4) {
        const ground = new Vector3(x, y, paperThickness);
        const expected = rayHit(meshes, ground, tilt);
        const actual = pick(ground);
        expect(Boolean(actual)).toBe(Boolean(expected));
        if (actual && expected) {
          expect(actual.distanceTo(expected)).toBeLessThan(1e-6);
        }
      }
    }
  }
});

it("honors front-face culling at both atlas and diorama angles", () => {
  const geometry = triangle([-12, 0, 0, 12, 0, 0, 0, -10, 30]);
  let tilt = 0;
  const pick = createTerrainPicker([geometry], () => tilt);
  const pointOnSlope = new Vector3(0, -10 / 3, 10);
  const ground = () =>
    new Vector3(
      pointOnSlope.x,
      pointOnSlope.y + (pointOnSlope.z - paperThickness) * Math.tan(tilt),
      paperThickness
    );
  expect(pick(ground())).toBeUndefined();
  tilt = dioramaTilt;
  expect(pick(ground())?.distanceTo(pointOnSlope)).toBeLessThan(1e-6);
  tilt = 0;
  expect(pick(ground())).toBeUndefined();
});
