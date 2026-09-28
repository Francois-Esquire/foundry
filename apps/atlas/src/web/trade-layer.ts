import * as THREE from "three";
import { laneWidth } from "./codex/bindings";
import { compositionInsideLand } from "./composition-placement";
import { roundSeaLane } from "./sea-lane";
import { terrainHeight } from "./terrain";
import type { TradePoint, TradePort, TradeRoute } from "./trade-routes";
import type { AtlasData, Territory } from "./types";

export function createTradeLayer(
  data: AtlasData,
  inlandPackages = new Set<string>()
) {
  const group = new THREE.Group();
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 8).rotateX(Math.PI / 2);
  const cone = new THREE.ConeGeometry(1, 1, 8).rotateX(Math.PI / 2);
  const roofShape = new THREE.Shape()
    .moveTo(-0.5, 0)
    .lineTo(0.5, 0)
    .lineTo(0, 0.5)
    .closePath();
  const roof = new THREE.ExtrudeGeometry(roofShape, {
    bevelEnabled: false,
    depth: 1,
  })
    .translate(0, 0, -0.5)
    .rotateX(Math.PI / 2);
  const material = (color: string) =>
    new THREE.MeshStandardMaterial({
      color,
      metalness: 0,
      opacity: 1,
      roughness: 0.9,
      transparent: true,
    });
  const stone = material("#ead6a5"),
    walls = material("#f1ead9"),
    roofs = material("#875222"),
    timber = material("#4a4233");
  const uniforms = {
    ink: { value: new THREE.Color("#875222") },
  };
  const laneMaterial = new THREE.ShaderMaterial({
    depthWrite: false,
    fragmentShader: `uniform vec3 ink; varying float laneLength; varying vec2 laneUv;
      void main() {
        if (mod(min(laneUv.x, laneLength - laneUv.x), 14.0) > 8.0) discard;
        float edge = 1.0 - smoothstep(0.7, 1.0, abs(laneUv.y));
        gl_FragColor = vec4(ink, edge * 0.65);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide,
    transparent: true,
    uniforms,
    vertexShader: `attribute float routeLength; varying float laneLength; varying vec2 laneUv;
      void main() { laneUv = uv; laneLength = routeLength; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  });
  let paths: THREE.BufferGeometry[] = [];
  let signature = "";
  let occupied: { x: number; y: number; radius: number }[] = [];
  const mesh = (
    parent: THREE.Group,
    geometry: THREE.BufferGeometry,
    surface: THREE.Material,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number
  ) => {
    const item = new THREE.Mesh(geometry, surface);
    item.position.set(x, y, z);
    item.scale.set(sx, sy, sz);
    item.castShadow = item.receiveShadow = true;
    item.renderOrder = 2;
    parent.add(item);
    return item;
  };
  const port = (p: Territory, site: TradePort, resource: boolean) => {
    if (inlandPackages.has(p.id)) {
      return;
    }
    const town = new THREE.Group();
    town.userData.territory = p.id;
    const vertices = p.coast.flat(2);
    const xs = vertices.map(([x]) => x),
      ys = vertices.map(([, y]) => y);
    const scale = Math.min(
      1,
      Math.max(
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys)
      ) / 200
    );
    const origin = 0.4 * (1 - scale);
    town.scale.setScalar(scale);
    const angle = -Math.atan2(
      site.water.y - site.coast.y,
      site.water.x - site.coast.x
    );
    town.position.set(site.coast.x, -site.coast.y, origin);
    town.rotation.z = angle;
    group.add(town);
    const local = (rawX: number, rawY: number) => {
      const x = rawX * scale,
        y = rawY * scale;
      return {
        x: site.coast.x + Math.cos(angle) * x - Math.sin(angle) * y - p.x,
        y: -(-site.coast.y + Math.sin(angle) * x + Math.cos(angle) * y) - p.y,
      };
    };
    const fits = (x: number, y: number, w: number, d: number) =>
      [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ].every(([dx = 0, dy = 0]) => {
        const q = local(x + (dx * w) / 2, y + (dy * d) / 2);
        return compositionInsideLand(q.x, q.y, p.coast);
      });
    const building = (
      x: number,
      y: number,
      w: number,
      d: number,
      h: number
    ) => {
      if (!fits(x, y, w + 1, d + 1)) {
        return;
      }
      const center = local(x, y),
        radius = (Math.hypot(w + 1, d + 1) * scale) / 2;
      const position = { radius, x: center.x + p.x, y: center.y + p.y };
      if (
        occupied.some(
          (other) =>
            Math.hypot(other.x - position.x, other.y - position.y) <
            other.radius + radius + scale
        )
      ) {
        return;
      }
      occupied.push(position);
      const heights = [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ].map(([dx = 0, dy = 0]) => {
        const q = local(x + (dx * w) / 2, y + (dy * d) / 2);
        return (terrainHeight(p, q.x, q.y) - origin) / scale;
      });
      const base = Math.max(...heights),
        bottom = Math.min(...heights);
      mesh(
        town,
        cube,
        stone,
        x,
        y,
        (base + bottom) / 2 + 0.4,
        w + 1,
        d + 1,
        base - bottom + 0.8
      );
      mesh(town, cube, walls, x, y, base + h / 2 + 0.8, w, d, h);
      mesh(town, roof, roofs, x, y, base + h + 0.8, w + 1, d + 1, w * 0.65);
      mesh(
        town,
        cube,
        timber,
        x + w / 2 + 0.03,
        y,
        base + 2,
        0.15,
        d * 0.32,
        2.4
      );
    };
    mesh(town, cube, stone, 0, 0, 0.75, 5, 22, 1.5);
    for (const y of [-8, 7]) {
      mesh(town, cube, timber, 7, y, 1.15, 15, 2.5, 1);
      for (const x of [2, 12]) {
        mesh(town, cylinder, timber, x, y, 0.6, 0.55, 0.55, 2.4);
      }
      mesh(town, cube, timber, 13, y, 1.15, 2.5, 7, 1);
    }
    building(-8, -7, 7, 9, resource ? 7 : 5);
    building(-9, 7, 6, 8, 4);
    building(-19, -6, resource ? 10 : 7, 8, resource ? 8 : 5);
    building(-19, 8, 6, 7, 5);
    if (resource) {
      building(-29, 1, 7, 10, 6);
    }
    if (fits(-3, 12, 3, 3)) {
      const q = local(-3, 12),
        base = (terrainHeight(p, q.x, q.y) - origin) / scale;
      mesh(town, cylinder, walls, -3, 12, base + 4, 1.5, 1.5, 8);
      mesh(town, cone, roofs, -3, 12, base + 9, 2.2, 2.2, 2);
    }
  };
  const clearWater = (a: TradePoint, b: TradePoint) => {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
    for (let n = 0; n <= steps; n++) {
      const t = n / Math.max(1, steps),
        x = a.x + (b.x - a.x) * t,
        y = a.y + (b.y - a.y) * t;
      if (
        data.territories.some((p) =>
          compositionInsideLand(x - p.x, y - p.y, p.coast)
        )
      ) {
        return false;
      }
    }
    return true;
  };
  return {
    dispose: () => {
      paths.forEach((geometry) => {
        geometry.dispose();
      });
      for (const geometry of [cube, cylinder, cone, roof]) {
        geometry.dispose();
      }
      for (const surface of [stone, walls, roofs, timber, laneMaterial]) {
        surface.dispose();
      }
      group.clear();
    },
    group,
    pick: (raycaster: THREE.Raycaster) => {
      if (!group.visible) {
        return;
      }
      const hit = raycaster.intersectObjects(
        group.children.filter((child) => child instanceof THREE.Group),
        true
      )[0];
      const id: unknown = hit?.object.parent?.userData.territory;
      return data.territories.find((p) => p.id === id);
    },
    setRoutes: (routes: TradeRoute[]) => {
      const next = JSON.stringify(
        routes.map((r) => [
          r.dependency.from,
          r.dependency.to,
          r.dependency.weight,
        ])
      );
      if (next === signature) {
        return;
      }
      signature = next;
      group.clear();
      paths.forEach((geometry) => {
        geometry.dispose();
      });
      paths = [];
      occupied = [];
      const painted: TradePort[] = [];
      const maximum = Math.max(1, ...routes.map((r) => r.dependency.weight));
      for (const route of routes) {
        const points = roundSeaLane(
          [route.consumer.coast, ...route.points, route.supplier.coast],
          clearWater
        );
        const positions: number[] = [],
          uv: number[] = [],
          indices: number[] = [];
        let length = 0;
        points.forEach((p, i) => {
          const before = points[i - 1] ?? p,
            after = points[i + 1] ?? p;
          length += Math.hypot(p.x - before.x, p.y - before.y);
          const dx = after.x - before.x,
            dy = after.y - before.y,
            magnitude = Math.hypot(dx, dy) || 1;
          const width = laneWidth(route.dependency.weight, maximum);
          for (const side of [-1, 1]) {
            positions.push(
              p.x - (dy / magnitude) * width * side,
              -p.y - (dx / magnitude) * width * side,
              0.08
            );
            uv.push(length, side);
          }
          if (i) {
            const j = i * 2;
            indices.push(j - 2, j - 1, j, j - 1, j + 1, j);
          }
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(positions, 3)
        );
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
        geometry.setAttribute(
          "routeLength",
          new THREE.Float32BufferAttribute(
            new Float32Array(points.length * 2).fill(length),
            1
          )
        );
        geometry.setIndex(indices);
        paths.push(geometry);
        group.add(new THREE.Mesh(geometry, laneMaterial));
        for (const [site, resource] of [
          [route.supplier, true],
          [route.consumer, false],
        ] as const) {
          if (
            painted.some(
              (s) =>
                s.territory === site.territory &&
                Math.hypot(s.coast.x - site.coast.x, s.coast.y - site.coast.y) <
                  25
            )
          ) {
            continue;
          }
          const p = data.territories.find((p) => p.id === site.territory);
          if (p) {
            port(p, site, resource);
            painted.push(site);
          }
        }
      }
    },
  };
}
