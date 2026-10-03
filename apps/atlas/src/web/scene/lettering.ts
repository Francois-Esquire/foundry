import { Mesh, MeshBasicMaterial, PlaneGeometry } from "three";
import { insidePolygons } from "../atmosphere";
import { islandPlinth } from "../codex/bindings";
import type { AtlasFile, Territory } from "../types";
import type { InkView, MapLabel } from "./exploration";
import { createInkTexture } from "./ink-texture";
import { paperThickness } from "./paper-material";
import type { TerrainField } from "./terrain-field";

/** Shift the anchor with relief; keep the engraved letterforms undistorted. */
export function elevatedLabel(
  label: MapLabel,
  elevation: number,
  tilt: number
): MapLabel {
  return { ...label, y: label.y - elevation * Math.tan(tilt) };
}

export function createLettering() {
  const canvas = document.createElement("canvas");
  let texture = createInkTexture(canvas);
  const material = new MeshBasicMaterial({
    depthTest: false,
    depthWrite: false,
    map: texture,
    transparent: true,
  });
  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  mesh.renderOrder = 3;
  return {
    canvas,
    dispose() {
      texture.dispose();
      material.dispose();
      mesh.geometry.dispose();
    },
    mesh,
    resize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
      texture.dispose();
      texture = createInkTexture(canvas);
      material.map = texture;
    },
    update(view: InkView) {
      mesh.scale.set(view.width, view.height, 1);
      mesh.position.set(view.x, -view.y, paperThickness + 0.02);
      texture.needsUpdate = true;
    },
  };
}

/** File anchors are invariant under camera movement; fields change only with evidence. */
export function createLabelProjector(
  fieldFor: (territory: Territory) => TerrainField,
  tilt: number
) {
  const fields = new WeakMap<TerrainField, WeakMap<AtlasFile, number>>();
  return (label: MapLabel) => {
    const { territory, file } = label;
    const field = fieldFor(territory);
    if (!file) {
      const local = { x: label.x - territory.x, y: label.y - territory.y };
      if (!insidePolygons(local, territory.coast)) {
        return label;
      }
      const { elevation } = field.sample(local.x, local.y);
      return elevatedLabel(label, islandPlinth + elevation, tilt);
    }
    const cache = fields.get(field) ?? new WeakMap<AtlasFile, number>();
    fields.set(field, cache);
    let elevation = cache.get(file);
    if (elevation === undefined) {
      elevation = islandPlinth + field.sample(file.x, file.y).elevation;
      cache.set(file, elevation);
    }
    return elevatedLabel(label, elevation, tilt);
  };
}
