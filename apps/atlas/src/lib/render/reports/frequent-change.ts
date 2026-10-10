import type { FrequentChange } from "../../lenses/frequent-change-types";
import { byId } from "../../workspace-projection";
import type { RenderDensity } from "../context";
import { LISTED_AT_DENSITY } from "../context";
import { count, percent } from "../format";
import type { BlockView, ReportView, SectionView } from "../views";

/** The `frequent-change` lens: the gate, then the files with the most commits first. */
export function buildFrequentChangeView(
  lens: FrequentChange,
  density: RenderDensity
): ReportView {
  const files = lens.packages.flatMap((pkg) =>
    pkg.files.map((file) => ({ ...file, package: pkg.id }))
  );
  const ranked = [...files].sort(
    (a, b) => b.commits - a.commits || byId(a.file, b.file)
  );
  const shown = ranked.slice(0, LISTED_AT_DENSITY[density]);
  const sections: SectionView[] = [
    {
      blocks: [
        {
          kind: "labelValue",
          rows: [
            {
              label: "Gate",
              value: `${lens.gate.eligibleKinds.join(", ")} files at or above the ${percent(lens.gate.minCommitPercentile)} commit percentile`,
            },
            { label: "Packages", value: count(lens.packages.length) },
            { label: "Files", value: count(files.length) },
          ],
        },
      ],
    },
  ];
  if (shown.length > 0) {
    const list: BlockView = {
      items: shown.map((file) => ({
        detail: [
          `${file.package} · ${percent(file.commitPercentile)} commit percentile`,
        ],
        label: file.file,
        value: file.commits,
      })),
      kind: "rankedList",
      ...(ranked.length > shown.length && {
        overflow: ranked.length - shown.length,
      }),
    };
    sections.push({ blocks: [list], title: "Frequently changed files" });
  }
  if (lens.missing.length > 0) {
    sections.push({
      blocks: [{ items: lens.missing, kind: "list" }],
      title: "Saved without churn",
    });
  }
  return { sections, title: "Frequent change" };
}
