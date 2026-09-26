import { clearOfCoast, compositionInsideLand } from "./composition-placement";
import type { AtlasInternals } from "./internals";
import type { AtlasFile, Territory } from "./types";

function hash(value: string) {
  let result = 2_166_136_261;
  for (const character of value) {
    result = Math.imul(result ^ character.charCodeAt(0), 16_777_619);
  }
  return result >>> 0;
}

export function planDistricts(data: AtlasInternals, territory: Territory) {
  const files = new Map(territory.files.map((file) => [file.id, file]));
  const desired = new Map<string, { x: number; y: number }>();
  for (const region of data.responsibilities.regions) {
    const members = region.modules.flatMap(
      (module) => files.get(data.fileIds[module] ?? "") ?? []
    );
    if (!members.length) {
      continue;
    }
    const x = members.reduce((sum, file) => sum + file.x, 0) / members.length;
    const y = members.reduce((sum, file) => sum + file.y, 0) / members.length;
    for (const file of members) {
      const seed = hash(file.id);
      const angle = (seed / 4_294_967_296) * Math.PI * 2;
      const radius =
        Math.sqrt(hash(`${file.id}:radius`) / 4_294_967_296) *
        Math.max(4, Math.sqrt(members.length) * 2.8);
      desired.set(file.id, {
        x: x * 0.8 + file.x * 0.2 + Math.cos(angle) * radius,
        y: y * 0.8 + file.y * 0.2 + Math.sin(angle) * radius,
      });
    }
  }
  return territory.files.map((file) => ({
    id: file.id,
    ...(desired.get(file.id) ?? { x: file.x, y: file.y }),
  }));
}

function coastSites(territory: Territory) {
  const sites: { x: number; y: number; component: number }[] = [];
  territory.coast.forEach((polygon, component) => {
    const ring = polygon[0];
    if (!ring?.length) {
      return;
    }
    const minX = Math.min(...ring.map((point) => point[0])),
      maxX = Math.max(...ring.map((point) => point[0]));
    const minY = Math.min(...ring.map((point) => point[1])),
      maxY = Math.max(...ring.map((point) => point[1]));
    for (
      let row = Math.ceil(minY / 3.2);
      row <= Math.floor(maxY / 3.2);
      row++
    ) {
      const offset = Math.abs(row % 2) * 1.8;
      for (
        let column = Math.ceil((minX - offset) / 3.6);
        column <= Math.floor((maxX - offset) / 3.6);
        column++
      ) {
        const x = column * 3.6 + offset,
          y = row * 3.2;
        if (
          !(
            compositionInsideLand(x, y, [polygon]) &&
            clearOfCoast(x, y, [polygon], 1.9)
          )
        ) {
          continue;
        }
        sites.push({ component, x, y });
      }
    }
  });
  return sites;
}

export function fitDistricts(
  territory: Territory,
  planned: readonly { id: string; x: number; y: number }[]
) {
  const sites = coastSites(territory);
  const targets = new Map(planned.map((point) => [point.id, point]));
  const placed = new Map<string, AtlasFile>();
  const unplaced: string[] = [];
  for (const file of [...territory.files].sort((a, b) =>
    a.id.localeCompare(b.id)
  )) {
    const component = territory.coast.findIndex((polygon) =>
      compositionInsideLand(file.x, file.y, [polygon])
    );
    const target = targets.get(file.id) ?? file;
    let best = -1,
      distance = Number.POSITIVE_INFINITY;
    sites.forEach((site, index) => {
      if (component >= 0 && site.component !== component) {
        return;
      }
      const next = (site.x - target.x) ** 2 + (site.y - target.y) ** 2;
      if (next < distance) {
        best = index;
        distance = next;
      }
    });
    const site = sites[best];
    if (!site) {
      unplaced.push(file.id);
      continue;
    }
    placed.set(file.id, { ...file, x: site.x, y: site.y });
    sites.splice(best, 1);
  }
  return {
    files: territory.files.flatMap((file) => placed.get(file.id) ?? []),
    unplaced,
  };
}

export function districtLayout(data: AtlasInternals, territory: Territory) {
  const fitted = fitDistricts(territory, planDistricts(data, territory));
  const modules = new Map(
    data.architecture?.primitives.modules.map((module) => [
      data.fileIds[module.module],
      module,
    ]) ?? []
  );
  const roots = new Set(
    data.architecture?.rewiring.composition
      .filter((module) => module.compositionRoot)
      .map((module) => data.fileIds[module.module]) ?? []
  );
  const classified = fitted.files.map((file): AtlasFile => {
    const module = modules.get(file.id);
    let architectureKind: AtlasFile["architectureKind"];
    if (roots.has(file.id)) {
      architectureKind = "junction";
    } else if (module) {
      if (module.composition.scopes === "mixed-scope") {
        architectureKind = "mixed";
      } else if (
        module.fragmentation.localGroups === 0 &&
        module.fragmentation.crossResponsibility +
          module.fragmentation.packageWide >
          0
      ) {
        architectureKind = "commons";
      } else if (
        module.unresolvedSymbols === module.symbols &&
        module.symbols > 0
      ) {
        architectureKind = "unknown";
      }
    }
    return { ...file, architectureKind };
  });
  return {
    territory: {
      ...territory,
      files: classified,
      neighborhoods: data.responsibilities.regions.map((region) => ({
        id: region.id,
        imports: region.topology.internalEdges,
        label: region.label,
        members: region.modules.flatMap((module) => data.fileIds[module] ?? []),
        sharedConcepts: region.concepts.declared.length,
      })),
    },
    unplaced: fitted.unplaced,
  };
}
