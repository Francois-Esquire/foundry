import * as THREE from "three";

import type { createRoadNetwork } from "./roads";

export function createRoadLayer(network: ReturnType<typeof createRoadNetwork>) {
  const positions: number[] = [],
    colors: number[] = [];
  const maximum = Math.max(1, ...network.segments.map((s) => s.weight));
  for (const { points, weight } of network.paths) {
    for (let j = 1; j < points.length; j++) {
      const a = points[j - 1],
        b = points[j];
      if (!(a && b)) {
        continue;
      }
      const dx = b.x - a.x,
        dy = b.y - a.y,
        length = Math.hypot(dx, dy);
      const width = 0.7 + Math.log1p(weight) / Math.log1p(maximum);
      const count = Math.ceil(length / 2);
      const color = new THREE.Color("#997c4e");
      for (let i = 0; i < count; i++) {
        const corners = [i, i + 1].flatMap((n) =>
          [-1, 1].map((side) => {
            const p = {
              x: a.x + (dx * n) / count - (dy / length) * width * side,
              y: a.y + (dy * n) / count + (dx / length) * width * side,
            };
            return [p.x, -p.y, network.elevation(p) + 0.25];
          })
        );
        for (const j of [0, 1, 2, 1, 3, 2]) {
          positions.push(...(corners[j] ?? []));
          colors.push(color.r, color.g, color.b);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({
    depthWrite: false,
    opacity: 0.75,
    side: THREE.DoubleSide,
    transparent: true,
    vertexColors: true,
  });
  const group = new THREE.Mesh(geometry, material);
  return {
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
    group,
    update: (pixels: number) => {
      material.opacity = 0.75 / Math.max(1, pixels / 1.2);
    },
  };
}
