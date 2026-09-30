import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  type Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Shape,
  ShapeGeometry,
  Vector2,
} from "three";
import { TessellateModifier } from "three/addons/modifiers/TessellateModifier.js";

import type { Continent } from "../continent";
import {
  continentHeight,
  forestSites,
  settlementBuildings,
} from "../continent";
import { unit } from "../geography";
import type { TradeRoute } from "../trade-routes";
import type { AtlasData } from "../types";
import { terrainHeight } from "./terrain";

export function ecosystemOpacity(pixels: number) {
  const t = Math.max(0, Math.min(1, (pixels - 1.1) / 1.8));
  return 1 - t * t * (3 - 2 * t);
}

export function createEcosystemLayer(
  data: AtlasData,
  continents: Continent[],
  paper: Material,
  routes: Pick<TradeRoute, "points">[],
  layers = { forests: true, houses: true }
) {
  const group = new Group(),
    props = new Group();
  group.add(props);
  const geometries: BufferGeometry[] = [];
  for (const continent of continents) {
    for (const ring of continent.field.outline) {
      const base = new ShapeGeometry(
        new Shape(ring.map(([x, y]) => new Vector2(x, -y)))
      );
      const geometry = new TessellateModifier(16, 12).modify(base);
      base.dispose();
      const positions = geometry.getAttribute("position"),
        uv = geometry.getAttribute("uv");
      for (let i = 0; i < positions.count; i += 1) {
        const x = positions.getX(i),
          y = positions.getY(i);
        positions.setZ(i, continentHeight(continent, x, -y));
        uv.setXY(i, x / data.width + 0.5, y / data.height + 0.5);
      }
      geometry.computeVertexNormals();
      const mesh = new Mesh(geometry, paper);
      mesh.receiveShadow = true;
      group.add(mesh);
      geometries.push(geometry);
    }
  }
  const material = (color: string) =>
    new MeshStandardMaterial({
      color,
      roughness: 0.95,
      transparent: true,
    });
  const walls = material("#ead6b1"),
    roofs = material("#976640"),
    trunks = material("#786345"),
    leaves = material("#8caa71");
  const materials = [walls, roofs, trunks, leaves];
  const cube = new BoxGeometry(1, 1, 1),
    crown = new IcosahedronGeometry(1, 1);
  const trunk = new CylinderGeometry(0.22, 0.35, 1, 5).rotateX(Math.PI / 2);
  const roofShape = new Shape()
    .moveTo(-0.5, 0)
    .lineTo(0.5, 0)
    .lineTo(0, 0.5)
    .closePath();
  const roof = new ExtrudeGeometry(roofShape, {
    bevelEnabled: false,
    depth: 1,
  })
    .translate(0, 0, -0.5)
    .rotateX(Math.PI / 2);
  geometries.push(cube, crown, trunk, roof);
  const instance = (
    geometry: BufferGeometry,
    surface: Material,
    items: Instance[]
  ) => {
    const mesh = new InstancedMesh(geometry, surface, items.length);
    const object = new Object3D();
    for (const [i, p] of items.entries()) {
      object.position.set(p.x, -p.y, p.z);
      object.scale.set(p.sx, p.sy, p.sz);
      object.rotation.z = p.angle ?? 0;
      object.updateMatrix();
      mesh.setMatrixAt(i, object.matrix);
      if (p.color) {
        mesh.setColorAt(i, p.color);
      }
    }
    mesh.receiveShadow = true;
    mesh.castShadow = mesh.receiveShadow;
    props.add(mesh);
  };
  const buildings: Instance[] = [],
    caps: Instance[] = [];
  const clearRoad = (x: number, y: number, radius: number) =>
    routes.every((route) =>
      route.points.slice(1).every((b, i) => {
        const a = route.points[i];
        if (!a) {
          return true;
        }
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)
          )
        );
        return Math.hypot(x - a.x - t * dx, y - a.y - t * dy) > radius + 5;
      })
    );
  createEcosystemLayerP(layers, data, clearRoad, buildings, caps);
  instance(cube, walls, buildings);
  instance(roof, roofs, caps);
  const wood: Instance[] = [],
    canopy: Instance[] = [];
  for (const continent of layers.forests ? continents : []) {
    for (const site of forestSites(continent)) {
      if (!clearRoad(site.x, site.y, site.size)) {
        continue;
      }
      const z = continentHeight(continent, site.x, site.y),
        shade = unit(`${site.x}:${site.y}`);
      wood.push({
        sx: 1,
        sy: 1,
        sz: site.size * 1.2,
        x: site.x,
        y: site.y,
        z: z + site.size * 0.6,
      });
      canopy.push({
        angle: shade * Math.PI,
        color: new Color().setHSL(
          0.22 + shade * 0.045,
          0.2,
          0.64 + shade * 0.2
        ),
        sx: site.size,
        sy: site.size * 0.85,
        sz: site.size * 0.8,
        x: site.x,
        y: site.y,
        z: z + site.size * 1.2,
      });
    }
  }
  instance(trunk, trunks, wood);
  instance(crown, leaves, canopy);
  let shadows = true;
  return {
    dispose: () => {
      for (const geometry of geometries) {
        geometry.dispose();
      }
      for (const surface of materials) {
        surface.dispose();
      }
      props.traverse((object) => {
        if (object instanceof InstancedMesh) {
          object.dispose();
        }
      });
    },
    group,
    update: (pixels: number, details: boolean) => {
      const opacity = details ? 0 : ecosystemOpacity(pixels);
      const cast = opacity > 0.95;
      const changed = cast !== shadows;
      shadows = cast;
      for (const child of props.children) {
        child.castShadow = cast;
      }
      props.visible = opacity > 0.01;
      for (const surface of materials) {
        surface.opacity = opacity;
        surface.depthWrite = opacity > 0.95;
      }
      return changed;
    },
  };
}

function createEcosystemLayerP(
  layers: { forests: boolean; houses: boolean },
  data: AtlasData,
  clearRoad: (x: number, y: number, radius: number) => boolean,
  buildings: Instance[],
  caps: Instance[]
) {
  for (const p of layers.houses ? data.territories : []) {
    for (const site of settlementBuildings(p)) {
      if (!clearRoad(p.x + site.x, p.y + site.y, site.size)) {
        continue;
      }
      const z = terrainHeight(p, site.x, site.y);
      const position = {
        angle: site.angle,
        sx: site.size,
        sy: site.size * 1.25,
        x: p.x + site.x,
        y: p.y + site.y,
      };
      buildings.push({ ...position, sz: site.height, z: z + site.height / 2 });
      caps.push({
        ...position,
        sx: site.size * 1.2,
        sy: site.size * 1.45,
        sz: site.size * 0.8,
        z: z + site.height,
      });
    }
  }
}
interface Instance {
  angle?: number;
  color?: Color;
  sx: number;
  sy: number;
  sz: number;
  x: number;
  y: number;
  z: number;
}
