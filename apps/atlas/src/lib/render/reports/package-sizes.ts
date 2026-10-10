import type { PackageSizes } from "../../lenses/package-sizes-types";
import type { RenderDensity } from "../context";
import { count } from "../format";
import type { ReportView, SectionView } from "../views";
import { rankedSection } from "./ranked-section";

const BY_PACKAGE = "Files by package";

/** The section an empty dependency graph still prints, its heading over no packages. */
const NO_PACKAGES: SectionView = {
  blocks: [{ items: [], kind: "rankedList" }],
  title: BY_PACKAGE,
};

/** The `package-sizes` lens: totals, then packages by file count, largest first. */
export function buildPackageSizesView(
  sizes: PackageSizes,
  density: RenderDensity
): ReportView {
  const { packages } = sizes;
  const files = packages.reduce((sum, pkg) => sum + pkg.modules.total, 0);
  const layers = new Set(
    packages.flatMap((pkg) => (pkg.layer === null ? [] : [pkg.layer]))
  );
  const byPackage = rankedSection(
    [...packages]
      .sort(
        (a, b) => b.modules.total - a.modules.total || a.id.localeCompare(b.id)
      )
      .map((pkg) => ({
        detail: [pkg.layer === null ? "no layer" : `layer ${pkg.layer}`],
        label: pkg.id,
        value: pkg.modules.total,
      })),
    density,
    BY_PACKAGE
  );
  return {
    sections: [
      {
        blocks: [
          {
            kind: "labelValue",
            rows: [
              {
                label: "Packages",
                value: `${count(packages.length)} (${count(packages.filter((pkg) => pkg.analyzed).length)} analyzed)`,
              },
              { label: "Layers", value: count(layers.size) },
              { label: "Files", value: count(files) },
            ],
          },
        ],
      },
      byPackage ?? NO_PACKAGES,
    ],
    title: "Package sizes",
  };
}
