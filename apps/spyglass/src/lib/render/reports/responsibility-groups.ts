import type { ResponsibilityGroups } from "../../lenses/responsibility-groups-types";
import { byId } from "../../workspace-projection";
import type { RenderDensity } from "../context";
import { count } from "../format";
import type { ReportView, SectionView } from "../views";
import { rankedSection } from "./ranked-section";

/** The `responsibility-groups` lens: totals, then the groups with the most responsibilities first. */
export function buildResponsibilityGroupsView(
  lens: ResponsibilityGroups,
  density: RenderDensity
): ReportView {
  const groups = lens.packages.flatMap((pkg) =>
    pkg.groups.map((group) => ({ ...group, package: pkg.id }))
  );
  const independent = lens.packages.reduce(
    (sum, pkg) => sum + pkg.independent.length,
    0
  );
  const ranked = [...groups].sort(
    (a, b) =>
      b.responsibilities.length - a.responsibilities.length ||
      byId(a.package, b.package) ||
      byId(a.id, b.id)
  );
  const sections: SectionView[] = [
    {
      blocks: [
        {
          kind: "labelValue",
          rows: [
            { label: "Packages", value: count(lens.packages.length) },
            { label: "Groups", value: count(groups.length) },
            {
              label: "Responsibilities in groups",
              value: count(
                groups.reduce(
                  (sum, group) => sum + group.responsibilities.length,
                  0
                )
              ),
            },
            {
              label: "Independent responsibilities",
              value: count(independent),
            },
          ],
        },
      ],
    },
  ];
  const listed = rankedSection(
    ranked.map((group) => ({
      detail: [
        group.anchorModule === undefined
          ? group.package
          : `${group.package} · anchored on ${group.anchorModule}`,
      ],
      label: group.label,
      value: group.responsibilities.length,
    })),
    density,
    "Responsibility groups"
  );
  if (listed !== undefined) {
    sections.push(listed);
  }
  if (lens.missing.length > 0) {
    sections.push({
      blocks: [{ items: lens.missing, kind: "list" }],
      title: "Saved without internals",
    });
  }
  return { sections, title: "Responsibility groups" };
}
