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
import type { ReliefOf } from "../layout/terrain-height";
import { coastWallGeometry, terrainGeometry } from "./terrain";

const cliffEarth = new Color(materials.cliffEarth);

/**
 * Every island's relief: its terrain surface on the shared paper, carrying
 * its own pigment, and its coast wall. Every mark on the land is draped on
 * these surfaces by the mark layers, and the relief as drawn is the
 * authority on the terrain: `islandOf` gives the island each surface was
 * built from, so a mark or a label on an island the drawing has since
 * relaid samples the field under it, not the relaid one's. The terrain
 * geometries are exposed for the pointer's hit test, which picks against
 * them.
 */
export function createReliefLayer(data: SpyglassData, paper: Material) {
  const group = new Group();
  const cliffs = new Group();
  const builtFrom = new Map(
    data.territories.map((territory) => [territory.id, territory])
  );
  /**
   * The island whose relief is drawn, for one as drawn, by id; an island
   * the chart lacks has no relief here, so it stands for itself, as every
   * island did before the relief was the authority.
   */
  const islandOf: ReliefOf = (island) => builtFrom.get(island.id) ?? island;
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
      let own = surfaces.get(territory.id);
      if (!own) {
        own = [];
        surfaces.set(territory.id, own);
      }
      own.push(surface);
      const wall = coastWallGeometry(territory, polygon);
      walls.push(wall);
      cliffs.add(new Mesh(wall, cliff));
      return shape;
    })
  );
  return {
    cliffs,
    dispose() {
      for (const geometry of geometries) {
        geometry.dispose();
      }
      for (const wall of walls) {
        wall.dispose();
      }
      cliff.dispose();
    },
    /** Every island's terrain surface, in chart space. */
    geometries,
    group,
    islandOf,
    /** An island's terrain surfaces, which the selection glow outlines; none for an id the chart lacks. */
    meshesOf: (territoryId: string): Mesh[] =>
      group.visible ? (surfaces.get(territoryId) ?? []) : [],
  };
}
