import * as THREE from "three";
import { unit } from "./geography";
import type { FormerPackage } from "./types";

function wreckMaterials() {
  const timber = new THREE.MeshStandardMaterial({
    color: "#4b655d",
    roughness: 1,
    side: THREE.DoubleSide,
  });
  const hold = new THREE.MeshStandardMaterial({
    color: "#304a47",
    roughness: 1,
  });
  const bone = new THREE.MeshStandardMaterial({
    color: "#829785",
    roughness: 1,
  });
  const canvas = new THREE.MeshStandardMaterial({
    color: "#95aa9e",
    roughness: 1,
    side: THREE.DoubleSide,
  });
  const seabed = new THREE.MeshStandardMaterial({
    color: "#a9bdad",
    roughness: 1,
  });
  return { bone, canvas, hold, seabed, timber };
}

function hullShape() {
  const shape = new THREE.Shape();
  shape.moveTo(-4.8, -11);
  shape.lineTo(-6, -6);
  shape.lineTo(-5.7, 3);
  shape.lineTo(-3, 11);
  shape.lineTo(0, 15);
  shape.lineTo(3, 11);
  shape.lineTo(5.7, 3);
  shape.lineTo(6, -6);
  shape.lineTo(4.8, -11);
  shape.closePath();
  const opening = new THREE.Shape();
  opening.moveTo(-3.3, -8.5);
  opening.lineTo(3.3, -8.5);
  opening.lineTo(4, 2.5);
  opening.lineTo(0, 11);
  opening.lineTo(-4, 2.5);
  opening.closePath();
  shape.holes.push(opening);
  return { opening, shape };
}

function beam(length: number, radius: number, material: THREE.Material) {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 6),
    material
  );
}

function lowerHull() {
  const sections = [
    { width: 4.5, y: -11 },
    { width: 5.7, y: -7 },
    { width: 5.8, y: 0 },
    { width: 4.6, y: 6 },
    { width: 2.3, y: 12 },
    { width: 0.2, y: 15 },
  ];
  const vertices: number[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < sections.length - 1; i++) {
      const a = sections[i];
      const b = sections[i + 1];
      if (!(a && b)) {
        continue;
      }
      const upperA = [side * a.width, a.y, 1.2];
      const upperB = [side * b.width, b.y, 1.2];
      const lowerA = [side * a.width * 0.4, a.y, -2];
      const lowerB = [side * b.width * 0.4, b.y, -2];
      vertices.push(
        ...upperA,
        ...lowerA,
        ...upperB,
        ...upperB,
        ...lowerA,
        ...lowerB
      );
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.computeVertexNormals();
  return geometry;
}

export function createWreckLayer(packages: FormerPackage[]) {
  const { timber, hold, bone, canvas, seabed } = wreckMaterials();
  const group = new THREE.Group();
  for (const pkg of packages) {
    const wreck = new THREE.Group();
    wreck.position.set(pkg.x, -pkg.y, -10);
    wreck.rotation.z = unit(`${pkg.id}:bearing`) * Math.PI * 2;
    const seaFloor = new THREE.Mesh(new THREE.CircleGeometry(39, 32), seabed);
    seaFloor.position.z = -2.2;
    seaFloor.receiveShadow = true;
    wreck.add(seaFloor);

    const { shape, opening } = hullShape();
    const hull = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, {
        bevelEnabled: true,
        bevelSegments: 1,
        bevelSize: 0.55,
        bevelThickness: 0.45,
        depth: 2.2,
      }),
      timber
    );
    hull.position.z = 0.45;
    hull.castShadow = true;
    wreck.add(hull);
    const keel = new THREE.Mesh(lowerHull(), timber);
    keel.castShadow = true;
    wreck.add(keel);

    const floor = new THREE.Mesh(new THREE.ShapeGeometry(opening), hold);
    floor.position.z = 0.5;
    wreck.add(floor);

    for (const y of [-6, -1, 4]) {
      const rib = beam(8.8 - Math.abs(y) * 0.35, 0.38, bone);
      rib.position.set(0, y, 1.7);
      rib.rotation.z = Math.PI / 2;
      wreck.add(rib);
    }

    const mast = beam(9, 0.62, timber);
    mast.position.set(-0.8, -1.5, 5.1);
    mast.rotation.x = 0.31;
    mast.rotation.y = 0.2;
    wreck.add(mast);
    const aftMast = beam(6, 0.45, timber);
    aftMast.position.set(0.5, -7, 5.2);
    aftMast.rotation.x = -0.4;
    wreck.add(aftMast);
    const spar = beam(10, 0.32, bone);
    spar.position.set(1.5, 1.2, 4.5);
    spar.rotation.x = 0.22;
    spar.rotation.z = 1.16;
    wreck.add(spar);
    const stern = new THREE.Mesh(new THREE.BoxGeometry(8.5, 4.5, 1.5), timber);
    stern.position.set(0, -7.8, 3.4);
    stern.castShadow = true;
    wreck.add(stern);
    const bowsprit = beam(11, 0.38, bone);
    bowsprit.position.set(0, 16, 3.1);
    bowsprit.rotation.x = Math.PI / 2.4;
    wreck.add(bowsprit);
    const sailShape = new THREE.BufferGeometry();
    sailShape.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          -4.5, -1.4, 7.3, 4.4, -1.4, 7.3, -2.3, -1.4, 3.5, 4.4, -1.4, 7.3, 1.7,
          -1.4, 4.3, -2.3, -1.4, 3.5,
        ],
        3
      )
    );
    sailShape.computeVertexNormals();
    wreck.add(new THREE.Mesh(sailShape, canvas));
    const rigging = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-1.5, -1.5, 8.8),
        new THREE.Vector3(-4.2, -9, 2.8),
        new THREE.Vector3(-1.5, -1.5, 8.8),
        new THREE.Vector3(0, 13, 2.5),
      ]),
      new THREE.LineBasicMaterial({
        color: "#667f74",
        opacity: 0.7,
        transparent: true,
      })
    );
    wreck.add(rigging);
    group.add(wreck);
  }
  return {
    dispose() {
      group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          (object as THREE.Mesh).geometry.dispose();
        }
        if (object instanceof THREE.LineSegments) {
          const line = object as THREE.LineSegments<
            THREE.BufferGeometry,
            THREE.LineBasicMaterial
          >;
          line.geometry.dispose();
          line.material.dispose();
        }
      });
      timber.dispose();
      hold.dispose();
      bone.dispose();
      canvas.dispose();
      seabed.dispose();
    },
    group,
  };
}
