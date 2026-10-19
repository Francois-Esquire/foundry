import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
} from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import type { SpyglassData } from "../data/types";
import {
  type Building,
  buildingVisible,
  layoutBuildings,
} from "../layout/buildings";
import type { ReliefOf } from "../layout/terrain-height";
import type { SceneLayer } from "./handle";

/** Unit gable, with its eaves at z=0 and ridge at z=1. */
function roofGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute(
      [
        -0.5, -0.5, 0, 0.5, -0.5, 0, 0, -0.5, 1, -0.5, 0.5, 0, 0.5, 0.5, 0, 0,
        0.5, 1,
      ],
      3
    )
  );
  geometry.setIndex([
    0, 1, 2, 3, 5, 4, 0, 2, 5, 0, 5, 3, 1, 4, 5, 1, 5, 2, 0, 3, 4, 0, 4, 1,
  ]);
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  flat.computeVertexNormals();
  return flat;
}

/**
 * Five instanced batches, regardless of file count: footings, pale stone
 * walls, dark eaves, warm gables and externally consumed module landmarks.
 * Resources survive camera motion; matrices change only with the depiction
 * or the set of files large enough to be read at this zoom.
 */
export function createArchitectureLayer(
  data: SpyglassData,
  reliefOf: ReliefOf = (territory) => territory
): SceneLayer {
  const group = new Group();
  group.name = "architecture";
  const cube = new BoxGeometry(1, 1, 1);
  const roof = roofGeometry();
  const landmarkRoof = new ConeGeometry(Math.SQRT1_2, 1, 4);
  landmarkRoof.rotateY(Math.PI / 4);
  landmarkRoof.rotateX(Math.PI / 2);
  landmarkRoof.translate(0, 0, 0.5);
  const stone = new MeshStandardNodeMaterial({
    color: "#e7d9b8",
    roughness: 0.92,
  });
  const foundation = new MeshStandardNodeMaterial({
    color: "#aaa087",
    roughness: 1,
  });
  const trim = new MeshStandardNodeMaterial({
    color: "#665749",
    roughness: 0.95,
  });
  const terracotta = new MeshStandardNodeMaterial({
    color: "#ae7054",
    roughness: 0.9,
  });
  const copper = new MeshStandardNodeMaterial({
    color: "#537f79",
    roughness: 0.85,
  });
  const specifications = [
    { geometry: cube, material: foundation, name: "footings" },
    { geometry: cube, material: stone, name: "walls" },
    { geometry: cube, material: trim, name: "eaves" },
    { geometry: roof, material: terracotta, name: "gables" },
    { geometry: landmarkRoof, material: copper, name: "landmarks" },
  ];
  let buildings = layoutBuildings(data, reliefOf);
  let capacity = Math.max(1, buildings.length);
  const makeBatches = () =>
    specifications.map(({ geometry, material, name }) => {
      const mesh = new InstancedMesh(geometry, material, capacity);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      group.add(mesh);
      return mesh;
    });
  let batches = makeBatches();
  let source = data;
  let previousPresentation = -1;
  let visible: Building[] = [];
  const matrix = new Matrix4();

  function write(
    mesh: InstancedMesh,
    building: Building,
    width: number,
    height: number,
    bottom: number,
    centered = true
  ) {
    matrix.makeScale(width, width, Math.max(0.001, height));
    matrix.setPosition(
      building.x,
      -building.y,
      bottom + (centered ? height / 2 : 0)
    );
    mesh.setMatrixAt(mesh.count, matrix);
    mesh.count += 1;
  }

  function draw(presentation: number) {
    for (const mesh of batches) {
      mesh.count = 0;
    }
    const [footings, walls, eaves, gables, landmarks] = batches;
    if (!(footings && walls && eaves && gables && landmarks)) {
      return;
    }
    for (const building of visible) {
      const base = building.base + building.footing;
      const height = building.height * presentation;
      const roofHeight =
        building.width * (building.landmark ? 0.8 : 0.38) * presentation;
      write(
        footings,
        building,
        building.width,
        building.footing + 0.08,
        building.base - 0.08
      );
      write(walls, building, building.width, height, base);
      write(
        eaves,
        building,
        building.width * 1.1,
        0.22 * presentation,
        base + height
      );
      write(
        building.landmark ? landmarks : gables,
        building,
        building.width * 1.1,
        roofHeight,
        base + height + 0.22 * presentation,
        false
      );
    }
    for (const mesh of batches) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
    }
  }

  return {
    dispose() {
      for (const mesh of batches) {
        mesh.dispose();
      }
      cube.dispose();
      roof.dispose();
      landmarkRoof.dispose();
      for (const material of [stone, foundation, trim, terracotta, copper]) {
        material.dispose();
      }
      group.clear();
    },
    group,
    id: "architecture",
    kind: "layer",
    stats: () => ({
      batches: batches.filter((mesh) => mesh.count > 0).length,
      buildings: visible.length,
      eligible: buildings.length,
    }),
    update(view, state) {
      if (state.drawingData !== source) {
        source = state.drawingData;
        buildings = layoutBuildings(source, reliefOf);
        if (buildings.length > capacity) {
          for (const mesh of batches) {
            group.remove(mesh);
            mesh.dispose();
          }
          capacity = buildings.length;
          batches = makeBatches();
        }
        previousPresentation = -1;
      }
      const presentation = Math.max(
        0,
        Math.min(1, view.presentation ?? state.settings.presentation)
      );
      const nextVisible =
        presentation > 0
          ? buildings.filter((building) =>
              buildingVisible(building, view.pixelsPerUnit)
            )
          : [];
      if (
        presentation === previousPresentation &&
        nextVisible.length === visible.length &&
        nextVisible.every((building, index) => building === visible[index])
      ) {
        return;
      }
      visible = nextVisible;
      previousPresentation = presentation;
      draw(presentation);
    },
  };
}
