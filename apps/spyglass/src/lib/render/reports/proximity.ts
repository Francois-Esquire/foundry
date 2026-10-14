import type { Proximity } from "../../lenses/proximity-types";
import { byId } from "../../workspace-projection";
import type { RenderDensity } from "../context";
import { count, plural } from "../format";
import type { ReportView, SectionView } from "../views";
import { rankedSection } from "./ranked-section";

/** The `proximity` lens: counts, then folders of unrelated groups, files apart from their responsibility, and co-changes apart. */
export function buildProximityView(
  lens: Proximity,
  density: RenderDensity
): ReportView {
  const { coChanges, files } = lens.apart;
  const unexplained = coChanges.filter(
    (pair) => pair.staticPath === "none"
  ).length;
  const unresolved = lens.packages.reduce(
    (sum, pkg) => sum + pkg.unresolved,
    0
  );
  const sections: SectionView[] = [
    {
      blocks: [
        {
          kind: "labelValue",
          rows: [
            {
              label: "Close, unrelated",
              value: `${plural(lens.close.length, "folder")} of unrelated groups`,
            },
            {
              label: "Files apart",
              value: `${count(files.length)} away from their responsibility's folder`,
            },
            {
              label: "Co-changes apart",
              value: `${count(coChanges.length)} across folders, ${count(unexplained)} with no import path`,
            },
            {
              label: "Unresolved",
              value: `${plural(unresolved, "file")} in no responsibility`,
            },
          ],
        },
      ],
    },
  ];
  const listed = [
    rankedSection(
      [...lens.close]
        .sort(
          (a, b) =>
            b.groups.length - a.groups.length || byId(a.folder, b.folder)
        )
        .map((folder) => ({
          detail: [
            `${folder.package} · ${plural(
              folder.groups.reduce((sum, group) => sum + group.files.length, 0),
              "file"
            )} · ${count(folder.unresolved)} unresolved`,
          ],
          label: folder.folder,
          value: folder.groups.length,
        })),
      density,
      "Folders of unrelated groups"
    ),
    rankedSection(
      [...files]
        .sort((a, b) => b.distance - a.distance || byId(a.file, b.file))
        .map((file) => ({
          detail: [
            `${file.package} · its responsibility in ${file.responsibilityFolder}`,
          ],
          label: file.file,
          value: file.distance,
        })),
      density,
      "Files away from their responsibility, by folder steps"
    ),
    rankedSection(
      [...coChanges]
        .sort(
          (a, b) =>
            b.distance - a.distance ||
            b.coChangeCommits - a.coChangeCommits ||
            byId(a.id, b.id)
        )
        .map((pair) => ({
          detail: [
            `with ${pair.right}`,
            `${plural(pair.coChangeCommits, "commit")} together · ${
              pair.staticPath === "none"
                ? "no import path"
                : `import path ${pair.staticPath}`
            }`,
          ],
          label: pair.left,
          value: pair.distance,
        })),
      density,
      "Changing together, apart, by folder steps"
    ),
  ];
  for (const section of listed) {
    if (section !== undefined) {
      sections.push(section);
    }
  }
  if (lens.missing.length > 0) {
    sections.push({
      blocks: [{ items: lens.missing, kind: "list" }],
      title: "Saved without internals",
    });
  }
  return { sections, title: "Proximity" };
}
