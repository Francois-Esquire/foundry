import { contours } from "d3-contour";
import { compositionInsideLand } from "./composition-placement";
import { classifyFiles } from "./district-layout";
import type { deriveHierarchy } from "./hierarchy";
import type { AtlasInternals } from "./internals";
import type { NaturalFeature } from "./natural-feature-inspection";
import type { NaturalFeatures } from "./natural-features";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import type { AtlasFile, Polygon, Territory } from "./types";

export interface BelongingRegion {
  anchor?: AtlasFile;
  anchorReason?: string;
  children?: string[];
  collection?: boolean;
  color: string;
  id: string;
  label: string;
  members: AtlasFile[];
  polygons: Polygon[];
  uncertain: boolean;
}

export interface BelongingLayer {
  emphasis?: number;
  featureFocus?: NaturalFeature;
  /** Landmarks, marshes, streams and confluences drawn from the same evidence. */
  features?: NaturalFeatures;
  files?: AtlasFile[];
  hovered?: string;
  parents?: BelongingRegion[];
  pinned?: string;
  regions: BelongingRegion[];
  reveal?: number;
  surroundings?: BelongingRegion[];
  territory: Territory;
}

export function belongingAncestry(
  regions: BelongingRegion[],
  composites: BelongingRegion[],
  selection: { compositeId?: string; regionId?: string; fileId?: string }
) {
  const entered = composites.find(
    (group) => group.id === selection.compositeId
  );
  const candidates = regions.filter((regionEntry) =>
    regionEntry.members.some((file) => file.id === selection.fileId)
  );
  const region =
    regions.find(
      (group) =>
        group.id === selection.regionId &&
        (!selection.fileId || candidates.includes(group))
    ) ??
    candidates.find((group) => entered?.children?.includes(group.id)) ??
    candidates[0];
  let composite: BelongingRegion | undefined;
  if (region) {
    if (entered?.children?.includes(region.id)) {
      composite = entered;
    } else {
      composite = composites.find((group) =>
        group.children?.includes(region.id)
      );
    }
  } else {
    composite = entered;
  }
  return {
    compositeId: composite?.id,
    regionId: region?.id ?? selection.regionId,
  };
}

const pigments = [
  "#688c77",
  "#b77864",
  "#798cac",
  "#a48a54",
  "#9e7992",
  "#609b9b",
];

function pigment(id: string) {
  let hash = 0;
  for (const character of id) {
    // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the deterministic 32-bit hash used for map placement and colors.
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the deterministic 32-bit hash used for map placement and colors.
  return pigments[(hash >>> 0) % pigments.length] ?? "#688c77";
}

export function memberContours(members: AtlasFile[]): Polygon[] {
  if (!members.length) {
    return [];
  }
  const radius = 6;
  const step = 1;
  const left = Math.floor(
    Math.min(...members.map((file) => file.x)) - radius - step
  );
  const top = Math.floor(
    Math.min(...members.map((file) => file.y)) - radius - step
  );
  const width = Math.ceil(
    Math.max(...members.map((file) => file.x)) + radius - left + step
  );
  const height = Math.ceil(
    Math.max(...members.map((file) => file.y)) + radius - top + step
  );
  const values = new Array<number>(width * height).fill(0);
  for (const file of members) {
    for (
      let y = Math.max(0, Math.floor(file.y - top - radius));
      y < Math.min(height, file.y - top + radius);
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.floor(file.x - left - radius));
        x < Math.min(width, file.x - left + radius);
        x += 1
      ) {
        const distance = Math.hypot(
          x + 0.5 + left - file.x,
          y + 0.5 + top - file.y
        );
        const influence = Math.max(0, 1 - (distance / radius) ** 2);
        const index = y * width + x;
        values[index] = Math.max(values[index] ?? 0, influence);
      }
    }
  }
  const [contour] = contours().size([width, height]).thresholds([0.32])(values);
  return (contour?.coordinates ?? []).map((polygon) =>
    polygon.map((ring) =>
      ring.map((point) => {
        const [x, y] = point as [number, number];
        return [x + left, y + top] as [number, number];
      })
    )
  );
}

export function belongingRegions(
  data: AtlasInternals,
  territory: Territory
): BelongingRegion[] {
  const files = new Map(
    classifyFiles(data, territory.files).map((file) => [file.id, file])
  );
  const region = (
    id: string,
    label: string,
    modules: string[],
    uncertain: boolean
  ) => {
    const members = [...new Set(modules.map((module) => data.fileIds[module]))]
      .flatMap((fileId2) => files.get(fileId2 ?? "") ?? [])
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      color: uncertain ? "#956f47" : pigment(id),
      id,
      label,
      members,
      polygons: memberContours(members),
      uncertain,
    };
  };
  return [
    ...data.responsibilities.regions.map((group) =>
      region(group.id, group.label, group.modules, false)
    ),
    ...data.responsibilities.unresolved.map((item) =>
      region(
        `unresolved:${item.module}`,
        item.module.split("/").at(-1) ?? item.module,
        [item.module],
        true
      )
    ),
  ]
    .filter((group) => group.members.length)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function hitBelonging(
  layer: BelongingLayer,
  x: number,
  y: number,
  pixels = 1
) {
  if (!compositionInsideLand(x, y, layer.territory.coast)) {
    return;
  }
  const parent = layer.parents?.find(
    (region) => region.children && !region.collection
  );
  if (parent && !compositionInsideLand(x, y, parent.polygons)) {
    return layer.regions.find((region) =>
      region.members.some(
        (file) => Math.hypot(file.x - x, file.y - y) <= 3 / pixels
      )
    );
  }
  const current = layer.regions.find((region) => region.id === layer.hovered);
  if (current && compositionInsideLand(x, y, current.polygons)) {
    return current;
  }
  return layer.regions
    .filter((region) => compositionInsideLand(x, y, region.polygons))
    .map((region) => ({
      distance: Math.min(
        ...region.members.map((file) => Math.hypot(file.x - x, file.y - y))
      ),
      region,
    }))
    .sort(
      (a, b) =>
        a.distance - b.distance || a.region.id.localeCompare(b.region.id)
    )[0]?.region;
}

export function compositeRegions(
  hierarchy: ReturnType<typeof deriveHierarchy>,
  regions: BelongingRegion[]
): BelongingRegion[] {
  const byId = new Map(regions.map((region) => [region.id, region]));
  const combine = (
    id: string,
    label: string,
    children: string[],
    collection = false
  ): BelongingRegion => {
    const members = [
      ...new Map(
        children
          .flatMap((child) => byId.get(child)?.members ?? [])
          .map((file) => [file.id, file])
      ).values(),
    ];
    return {
      children,
      collection,
      color: collection ? "#956f47" : pigment(id),
      id,
      label,
      members,
      polygons: [],
      uncertain: collection,
    };
  };
  const composites = hierarchy.composites.map((group) => {
    const region = combine(group.id, group.label, group.regions);
    const anchors = byId.get(group.anchor)?.members ?? [];
    region.anchor = [...anchors].sort(
      (a, b) => b.incoming - a.incoming || a.id.localeCompare(b.id)
    )[0];
    region.anchorReason = "Most connected responsibility within this district";
    return region;
  });
  districtContours(composites);
  const independent = hierarchy.independent.filter((id) => byId.has(id));
  const unresolved = regions
    .filter((region) => region.uncertain)
    .map((region) => region.id);
  if (independent.length) {
    composites.push(
      combine(
        "collection:independent",
        "Independent responsibilities",
        independent,
        true
      )
    );
  }
  if (unresolved.length) {
    composites.push(
      combine("collection:unresolved", "Unresolved belonging", unresolved, true)
    );
  }
  return composites.filter((region) => region.members.length);
}

function districtContours(regions: BelongingRegion[]) {
  const members = regions.flatMap((region) => region.members);
  if (!members.length) {
    return;
  }
  const radius = 22;
  const step = 2;
  const left = Math.min(...members.map((file) => file.x)) - radius;
  const top = Math.min(...members.map((file) => file.y)) - radius;
  const width = Math.ceil(
    (Math.max(...members.map((file) => file.x)) + radius - left) / step
  );
  const height = Math.ceil(
    (Math.max(...members.map((file) => file.y)) + radius - top) / step
  );
  const fields = regions.map((region) => {
    const values = new Float64Array(width * height);
    for (const file of region.members) {
      for (
        let y = Math.max(0, Math.floor((file.y - radius - top) / step));
        y < Math.min(height, (file.y + radius - top) / step);
        y += 1
      ) {
        for (
          let x = Math.max(0, Math.floor((file.x - radius - left) / step));
          x < Math.min(width, (file.x + radius - left) / step);
          x += 1
        ) {
          const distance = Math.hypot(
            left + (x + 0.5) * step - file.x,
            top + (y + 0.5) * step - file.y
          );
          const influence = Math.max(0, 1 - (distance / radius) ** 2) ** 3;
          const index = y * width + x;
          values[index] = (values[index] ?? 0) + influence;
        }
      }
    }
    return values;
  });
  for (const [index, region] of regions.entries()) {
    const values = Array.from(fields[index] ?? [], (value, cell) => {
      let other = 0;
      for (const [candidate, field] of fields.entries()) {
        if (candidate !== index) {
          other = Math.max(other, field[cell] ?? 0);
        }
      }
      return value - other * 1.08;
    });
    const [contour] = contours().size([width, height]).thresholds([0.08])(
      values
    );
    region.polygons = (contour?.coordinates ?? []).map((polygon) =>
      polygon.map((ring) =>
        ring.map(
          (point) =>
            [left + (point[0] ?? 0) * step, top + (point[1] ?? 0) * step] as [
              number,
              number,
            ]
        )
      )
    );
  }
}

export function matchedRegion(
  territory: Territory,
  overlay: ResponsibilityOverlay
): BelongingRegion | undefined {
  const ids = new Set([
    ...overlay.members,
    ...overlay.related,
    ...overlay.unresolved,
    ...resolveIds(overlay),
  ]);
  const members = territory.files.filter((file) => ids.has(file.id));
  if (!members.length) {
    return undefined;
  }
  return {
    color: "#a47b42",
    id: "evidence:matches",
    label: "",
    members,
    polygons: memberContours(members),
    uncertain: false,
  };
}

function resolveIds(overlay: ResponsibilityOverlay): string[] {
  if (overlay.routes) {
    return [...overlay.routes.baseline, ...overlay.routes.proposed].flatMap(
      (route) =>
        [route.source, route.target].flatMap((endpoint) =>
          endpoint.kind === "file" ? [endpoint.id] : []
        )
    );
  }
  return [];
}
