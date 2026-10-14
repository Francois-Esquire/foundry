import type { FileRole, FileRoles } from "../../lenses/file-roles-types";
import { byId } from "../../workspace-projection";
import type { RenderDensity } from "../context";
import { count } from "../format";
import type { ReportView, SectionView } from "../views";
import { rankedSection } from "./ranked-section";

/** Each file role's row label, in the order the roles are tried. */
const ROLE_ROWS: readonly (readonly [FileRole, string])[] = [
  ["junction", "Composition junctions"],
  ["mixed", "Mixed scope"],
  ["commons", "Shared commons"],
  ["unknown", "Unknown scope"],
];

/** The `file-roles` lens: files by role, then the high fan-in files, most imported first. */
export function buildFileRolesView(
  roles: FileRoles,
  density: RenderDensity
): ReportView {
  const modules = roles.packages.flatMap((pkg) =>
    pkg.modules.map((module) => ({ ...module, package: pkg }))
  );
  const byRole = ROLE_ROWS.map(([role, label]) => ({
    label,
    value: count(modules.filter((module) => module.role === role).length),
  }));
  const highFanIn = rankedSection(
    modules
      .filter((module) => module.highFanIn)
      .sort((a, b) => b.fanIn - a.fanIn || byId(a.module, b.module))
      .map((module) => ({
        detail: [
          `${module.package.id} · cutoff ${module.package.highFanInCutoff}`,
        ],
        label: module.module,
        value: module.fanIn,
      })),
    density,
    "High fan-in"
  );
  const sections: SectionView[] = [
    {
      blocks: [
        {
          kind: "labelValue",
          rows: [
            { label: "Packages", value: count(roles.packages.length) },
            { label: "Files", value: count(modules.length) },
            ...byRole,
          ],
        },
      ],
    },
  ];
  if (highFanIn !== undefined) {
    sections.push(highFanIn);
  }
  if (roles.missing.length > 0) {
    sections.push({
      blocks: [{ items: roles.missing, kind: "list" }],
      title: "Saved without internals",
    });
  }
  return { sections, title: "File roles" };
}
