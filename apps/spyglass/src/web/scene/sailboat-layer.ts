import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Mesh,
  Shape,
  ShapeGeometry,
  Vector3,
} from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import type { BoatPose } from "../layout/sailing";
import type { SceneLayer } from "./handle";

export interface SailboatLayer extends SceneLayer {
  setPose: (pose: BoatPose | null) => void;
}

function hullOutline(scale = 1): Shape {
  const shape = new Shape();
  shape.moveTo(0, 5.4 * scale);
  shape.bezierCurveTo(
    2.1 * scale,
    3.1 * scale,
    2.5 * scale,
    -1.9 * scale,
    1.4 * scale,
    -4.4 * scale
  );
  shape.lineTo(-1.4 * scale, -4.4 * scale);
  shape.bezierCurveTo(
    -2.5 * scale,
    -1.9 * scale,
    -2.1 * scale,
    3.1 * scale,
    0,
    5.4 * scale
  );
  shape.closePath();
  return shape;
}

function sail(vertices: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** A small cruising sailboat: geometry is fixed, only its world pose changes. */
export function createSailboatLayer(): SailboatLayer {
  const group = new Group();
  group.name = "sailboat";
  const vessel = new Group();
  vessel.visible = false;
  group.add(vessel);
  const hullMaterial = new MeshStandardNodeMaterial({
    color: "#315e69",
    roughness: 0.7,
  });
  const deckMaterial = new MeshStandardNodeMaterial({
    color: "#c8a676",
    roughness: 0.95,
  });
  const trimMaterial = new MeshStandardNodeMaterial({
    color: "#625140",
    roughness: 0.8,
  });
  const sailMaterial = new MeshStandardNodeMaterial({
    color: "#fff1cf",
    roughness: 0.95,
    side: DoubleSide,
  });
  const cabinMaterial = new MeshStandardNodeMaterial({
    color: "#eee3c8",
    roughness: 0.9,
  });
  const glassMaterial = new MeshStandardNodeMaterial({
    color: "#294a53",
    roughness: 0.45,
  });
  const riggingMaterial = new LineBasicMaterial({
    color: "#6d6252",
    opacity: 0.6,
    transparent: true,
  });
  const hull = new Mesh(
    new ExtrudeGeometry(hullOutline(), {
      bevelEnabled: true,
      bevelSegments: 2,
      bevelSize: 0.18,
      bevelThickness: 0.18,
      curveSegments: 12,
      depth: 0.9,
    }),
    hullMaterial
  );
  hull.position.z = -0.4;
  vessel.add(hull);
  const deck = new Mesh(new ShapeGeometry(hullOutline(0.87), 12), deckMaterial);
  deck.position.z = 0.72;
  vessel.add(deck);
  const cabin = new Mesh(new BoxGeometry(2.2, 2.1, 0.75), cabinMaterial);
  cabin.position.set(0, -0.65, 1.05);
  vessel.add(cabin);
  const window = new Mesh(new BoxGeometry(2.24, 0.75, 0.28), glassMaterial);
  window.position.set(0, -0.55, 1.14);
  vessel.add(window);
  const mast = new Mesh(new CylinderGeometry(0.1, 0.14, 8.6, 8), trimMaterial);
  mast.rotation.x = Math.PI / 2;
  mast.position.set(0, 0.55, 5);
  vessel.add(mast);
  const boom = new Mesh(new CylinderGeometry(0.07, 0.09, 3.8, 8), trimMaterial);
  boom.position.set(0.1, -1.35, 2.35);
  vessel.add(boom);
  // Facets give the canvas a modest belly; both sides are visible while turning.
  vessel.add(
    new Mesh(
      sail([
        0, 0.55, 9.1, 0, 0.55, 2.5, 0.65, -1.25, 4.7, 0, 0.55, 9.1, 0.65, -1.25,
        4.7, 0.15, -3.1, 2.5, 0, 0.55, 2.5, 0.15, -3.1, 2.5, 0.65, -1.25, 4.7,
      ]),
      sailMaterial
    )
  );
  vessel.add(
    new Mesh(
      sail([
        0.05, 0.8, 8.3, 0.1, 4.5, 1.1, 0.7, 2, 2.3, 0.05, 0.8, 8.3, 0.7, 2, 2.3,
        0.1, 0.85, 2,
      ]),
      sailMaterial
    )
  );
  const rigging = new LineSegments(
    new BufferGeometry().setFromPoints([
      new Vector3(0, 0.55, 9.3),
      new Vector3(0, 5.1, 0.7),
      new Vector3(0, 0.55, 9.3),
      new Vector3(0, -4.1, 0.7),
      new Vector3(0, 0.55, 7),
      new Vector3(-1.7, 0.4, 0.7),
      new Vector3(0, 0.55, 7),
      new Vector3(1.7, 0.4, 0.7),
    ]),
    riggingMaterial
  );
  vessel.add(rigging);
  vessel.traverse((object) => {
    if (object instanceof Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return {
    dispose() {
      const geometries = new Set<BufferGeometry>();
      const materials = new Set<Material>();
      vessel.traverse((object) => {
        if (object instanceof Mesh || object instanceof LineSegments) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material]) {
            materials.add(material);
          }
        }
      });
      for (const geometry of geometries) {
        geometry.dispose();
      }
      for (const material of materials) {
        material.dispose();
      }
      group.clear();
    },
    group,
    id: "sailboat",
    kind: "layer",
    setPose(pose) {
      vessel.visible = pose !== null;
      if (pose) {
        vessel.position.set(pose.x, -pose.y, 0);
        vessel.rotation.z = -pose.heading - Math.PI / 2;
      }
    },
    stats: () => ({ boats: vessel.visible ? 1 : 0 }),
  };
}
