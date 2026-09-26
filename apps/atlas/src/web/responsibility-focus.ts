import type { ResponsibilityRelationship } from "../lib/internal-responsibility-types";

import type { CompositionMark } from "./composition-layout";
import type { AtlasInternals } from "./internals";
import type { ScenarioRoute } from "./scenario-routes";

export type ResponsibilitySelection =
  | { kind: "region"; id: string; relationship?: ResponsibilityRelationship }
  | { kind: "unresolved"; id: string };

export interface ResponsibilityOverlay {
  composition?: {
    fileId: string;
    marks: CompositionMark[];
    active: string[];
    names: Record<string, string>;
    stationary?: string[];
  };
  hints?: string[];
  links: { source: string; target: string }[];
  members: string[];
  pathDisagreement: string[];
  reducedMotion?: boolean;
  related: string[];
  routes?: {
    baseline: ScenarioRoute[];
    proposed: ScenarioRoute[];
    progress: number;
    scopes: { id: string; files: string[] }[];
  };
  territoryId: string;
  totalLinks: number;
  trace?: {
    progress: number;
    blockers: string[];
    marks: CompositionMark[];
    stationary?: string[];
  };
  unresolved: string[];
}

export function responsibilityFocus(
  data: AtlasInternals,
  selection: ResponsibilitySelection
): ResponsibilityOverlay {
  const report = data.responsibilities;
  const region =
    selection.kind === "region"
      ? report.regions.find((r) => r.id === selection.id)
      : undefined;
  const ambiguity =
    selection.kind === "unresolved"
      ? report.unresolved.find((m) => m.module === selection.id)
      : undefined;
  const members = new Set(region?.modules ?? []);
  const unresolved = new Set(
    ambiguity
      ? [ambiguity.module]
      : region
        ? report.unresolved
            .filter((m) => m.candidates.some((c) => c.region === region.id))
            .map((m) => m.module)
        : []
  );
  const relationship =
    selection.kind === "region" ? selection.relationship : undefined;
  const relatedRegionIds = relationship
    ? [relationship.from, relationship.to].filter((id) => id !== region?.id)
    : (ambiguity?.candidates.map((c) => c.region) ?? []);
  const related = new Set(
    report.regions
      .filter((r) => relatedRegionIds.includes(r.id))
      .flatMap((r) => r.modules)
  );
  const owner = new Map(report.modules.map((m) => [m.module, m.region]));
  const edges = data.topology.edges
    .filter((edge) => {
      if (!edge.primary) {
        return false;
      }
      if (relationship) {
        return (
          owner.get(edge.source) === relationship.from &&
          owner.get(edge.target) === relationship.to
        );
      }
      return (
        (unresolved.has(edge.source) &&
          (members.has(edge.target) || related.has(edge.target))) ||
        (unresolved.has(edge.target) &&
          (members.has(edge.source) || related.has(edge.source)))
      );
    })
    .sort(
      (a, b) =>
        b.importSites - a.importSites ||
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target)
    );
  const mappedEdges = edges.flatMap((edge) => {
    const source = data.fileIds[edge.source],
      target = data.fileIds[edge.target];
    return source && target ? [{ source, target }] : [];
  });
  const mapped = (modules: Set<string>) =>
    [...modules].flatMap((id) => data.fileIds[id] ?? []).sort();
  return {
    links: mappedEdges.slice(0, 24),
    members: mapped(members),
    pathDisagreement: mapped(
      new Set(
        report.modules
          .filter(
            (m) => members.has(m.module) && m.pathAgreesWithRegion === false
          )
          .map((m) => m.module)
      )
    ),
    related: mapped(related),
    territoryId: report.package.id,
    totalLinks: mappedEdges.length,
    unresolved: mapped(unresolved),
  };
}
