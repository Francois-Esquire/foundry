import type { Nesting, NestingFolder } from "../../lenses/nesting-types";
import { byId } from "../../workspace-projection";
import type { RenderDensity } from "../context";
import { count, plural } from "../format";
import type { ReportView, SectionView } from "../views";
import { rankedSection } from "./ranked-section";

/** How many folders sit above a folder, through its parents. */
function depthOf(
  folder: NestingFolder,
  byFolder: ReadonlyMap<string, NestingFolder>
): number {
  let depth = 0;
  let { parent } = folder;
  while (parent !== undefined) {
    depth += 1;
    parent = byFolder.get(parent)?.parent;
  }
  return depth;
}

/** The `nesting` lens: the tree's size, then the folders with the most files directly in them, then the seams. */
export function buildNestingView(
  lens: Nesting,
  density: RenderDensity
): ReportView {
  const byFolder = new Map(lens.folders.map((folder) => [folder.id, folder]));
  const deepest = Math.max(
    0,
    ...lens.folders.map((folder) => depthOf(folder, byFolder))
  );
  const roots = lens.folders.filter((folder) => folder.packageRoot).length;
  const above = lens.folders.filter(
    (folder) => folder.package === undefined
  ).length;
  const sections: SectionView[] = [
    {
      blocks: [
        {
          kind: "labelValue",
          rows: [
            {
              label: "Folders",
              value: `${count(lens.folders.length)} (${count(roots)} package roots, ${count(above)} above every package)`,
            },
            { label: "Deepest", value: `${count(deepest)} below the top` },
            { label: "Path regions", value: count(lens.pathRegions.length) },
            { label: "Seams", value: count(lens.seams.length) },
          ],
        },
      ],
    },
  ];
  const folders = rankedSection(
    [...lens.folders]
      .filter((folder) => folder.fileCounts.direct > 0)
      .sort(
        (a, b) => b.fileCounts.direct - a.fileCounts.direct || byId(a.id, b.id)
      )
      .map((folder) => ({
        detail: [
          `${folder.package ?? "no package"} · ${plural(folder.fileCounts.descendant, "file")} below`,
        ],
        label: folder.id,
        value: folder.fileCounts.direct,
      })),
    density,
    "Folders by files"
  );
  const seams = rankedSection(
    [...lens.seams]
      .sort(
        (a, b) =>
          b.moduleEdges - a.moduleEdges ||
          byId(a.package, b.package) ||
          byId(a.from, b.from) ||
          byId(a.to, b.to)
      )
      .map((seam) => ({
        detail: [
          `${plural(seam.importSites, "import site")} · ${plural(seam.symbolFlow, "symbol")}`,
        ],
        label: `${seam.package}: ${seam.from} → ${seam.to}`,
        value: seam.moduleEdges,
      })),
    density,
    "Seams by module edges"
  );
  for (const section of [folders, seams]) {
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
  return { sections, title: "Nesting" };
}
