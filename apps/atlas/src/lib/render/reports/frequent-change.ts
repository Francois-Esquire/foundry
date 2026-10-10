import type { FrequentChange } from "../../lenses/frequent-change-types";
import { byId } from "../../workspace-projection";
import type { RenderDensity } from "../context";
import { count, percent } from "../format";
import type { ReportView, SectionView } from "../views";
import { rankedSection } from "./ranked-section";

/** The `frequent-change` lens: the gate, then the files with the most commits first. */
export function buildFrequentChangeView(
  lens: FrequentChange,
  density: RenderDensity
): ReportView {
  const files = lens.packages.flatMap((pkg) =>
    pkg.files.map((file) => ({ ...file, package: pkg.id }))
  );
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
  const changed = rankedSection(
    [...files]
      .sort((a, b) => b.commits - a.commits || byId(a.file, b.file))
      .map((file) => ({
        detail: [
          `${file.package} · ${percent(file.commitPercentile)} commit percentile`,
        ],
        label: file.file,
        value: file.commits,
      })),
    density,
    "Frequently changed files"
  );
  if (changed !== undefined) {
    sections.push(changed);
  }
  if (lens.missing.length > 0) {
    sections.push({
      blocks: [{ items: lens.missing, kind: "list" }],
      title: "Saved without churn",
    });
  }
  return { sections, title: "Frequent change" };
}
