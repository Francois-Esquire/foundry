import {
  type Group,
  InstancedMesh,
  type Object3D,
  Raycaster,
  Vector3,
} from "three";
import type { Building } from "../layout/buildings";
import { chartTilt, type InkView } from "../view/chart-view";

export interface BuildingHit {
  file: Building["file"];
  /** Actual intersection in Three world coordinates, for terrain occlusion. */
  point: Vector3;
  territory: Building["territory"];
}

/** Instance indices refer to the exact compacted batches the last repaint submitted. */
export type BuildingInstances = ReadonlyMap<InstancedMesh, readonly Building[]>;

/** Orthographic rays through the paper pick actual roofs and walls, closest first. */
export function createArchitecturePicker(
  group: Group,
  instances: () => BuildingInstances
): (point: Vector3, view: InkView) => BuildingHit | null {
  const raycaster = new Raycaster();
  const direction = new Vector3();
  const origin = new Vector3();
  return (point, view) => {
    for (
      let ancestor: Object3D | null = group;
      ancestor;
      ancestor = ancestor.parent
    ) {
      if (!ancestor.visible) {
        return null;
      }
    }
    const targets = instances();
    const meshes = [...targets.keys()].filter(
      (mesh) => mesh.visible && mesh.count > 0
    );
    if (!meshes.length || view.presentation === 0) {
      return null;
    }
    group.updateWorldMatrix(true, true);
    const ceiling =
      Math.max(
        ...meshes.map((mesh) => {
          const bounds = mesh.boundingBox
            ?.clone()
            .applyMatrix4(mesh.matrixWorld);
          return bounds?.max.z ?? point.z;
        })
      ) + 1;
    const tilt = view.tilt ?? chartTilt;
    direction.set(0, Math.sin(tilt), -Math.cos(tilt));
    origin
      .copy(point)
      .addScaledVector(direction, -(ceiling - point.z) / Math.cos(tilt));
    raycaster.set(origin, direction);
    const hits = raycaster.intersectObjects(meshes, false);
    for (const hit of hits) {
      if (
        hit.instanceId === undefined ||
        !(hit.object instanceof InstancedMesh)
      ) {
        continue;
      }
      const building = targets.get(hit.object)?.[hit.instanceId];
      if (building) {
        return {
          file: building.file,
          point: hit.point,
          territory: building.territory,
        };
      }
    }
    return null;
  };
}
