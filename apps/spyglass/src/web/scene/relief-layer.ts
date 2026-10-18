import {
  type BufferGeometry,
  Color,
  DoubleSide,
  Group,
  type Material,
  Mesh,
} from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import type { SpyglassData } from "../data/types";
import { grounds, materials } from "../ladder/ink-ladder";
import { baseTerrainField } from "../layout/terrain-field";
import { coastWallGeometry, terrainGeometry } from "./terrain";

const cliffEarth = new Color(materials.cliffEarth);

/**
 * Every island's relief: its terrain surface on the shared paper, carrying
 * its own pigment, and its coast wall. Every mark on the land is draped on
 * these surfaces by the mark layers. The terrain geometries are exposed for
 * the pointer's hit test, which picks against them.
 */
export function createReliefLayer(data: SpyglassData, paper: Material) {
  const group = new Group();
  // Raised coasts: every island's low cliff is the land a shade deeper.
  const cliff = new MeshStandardNodeMaterial({
    color: new Color(grounds.land).lerp(cliffEarth, 0.22),
    metalness: 0,
    roughness: 0.95,
    side: DoubleSide,
  });
  const walls: BufferGeometry[] = [];
  /** Each island's terrain meshes, one per coast polygon, by the island's id. */
  const surfaces = new Map<string, Mesh[]>();
  const geometries = data.territories.flatMap((territory) =>
    territory.coast.map((polygon) => {
      const shape = terrainGeometry(territory, polygon);
      const surface = new Mesh(shape, paper);
      group.add(surface);
      surfaces.set(territory.id, [
        ...(surfaces.get(territory.id) ?? []),
        surface,
      ]);
      const wall = coastWallGeometry(territory, polygon);
      walls.push(wall);
      group.add(new Mesh(wall, cliff));
      return shape;
    })
  );
  return {
    dispose() {
      for (const geometry of geometries) {
        geometry.dispose();
      }
      for (const wall of walls) {
        wall.dispose();
      }
      cliff.dispose();
    },
    fieldFor: baseTerrainField,
    /** Every island's terrain surface, in chart space. */
    geometries,
    group,
    /** An island's terrain surfaces, which the selection glow outlines; none for an id the chart lacks. */
    meshesOf: (territoryId: string): Mesh[] => surfaces.get(territoryId) ?? [],
  };
}
