import type { ImportTraffic } from "../../lenses/import-traffic-types";
import { byId } from "../../workspace-projection";
import type { RenderDensity } from "../context";
import { count, plural } from "../format";
import type { ReportView, SectionView } from "../views";
import { rankedSection } from "./ranked-section";

/** The `import-traffic` lens: how many package pairs and files, then the pairs by their files. */
export function buildImportTrafficView(
  lens: ImportTraffic,
  density: RenderDensity
): ReportView {
  const consumers = new Set(lens.pairs.flatMap((pair) => pair.consumerFiles));
  const suppliers = new Set(lens.pairs.flatMap((pair) => pair.supplierFiles));
  const sections: SectionView[] = [
    {
      blocks: [
        {
          kind: "labelValue",
          rows: [
            { label: "Package pairs", value: count(lens.pairs.length) },
            {
              label: "Files importing from another package",
              value: count(consumers.size),
            },
            {
              label: "Files another package imports",
              value: count(suppliers.size),
            },
          ],
        },
      ],
    },
  ];
  const pairs = rankedSection(
    [...lens.pairs]
      .sort(
        (a, b) =>
          b.consumerFiles.length - a.consumerFiles.length ||
          b.supplierFiles.length - a.supplierFiles.length ||
          byId(a.from, b.from) ||
          byId(a.to, b.to)
      )
      .map((pair) => ({
        detail: [
          `${plural(pair.consumerFiles.length, "file")} importing · ${plural(pair.supplierFiles.length, "file")} imported`,
        ],
        label: `${pair.from} → ${pair.to}`,
        value: pair.consumerFiles.length,
      })),
    density,
    "Pairs by importing files"
  );
  if (pairs !== undefined) {
    sections.push(pairs);
  }
  return { sections, title: "Import traffic" };
}
