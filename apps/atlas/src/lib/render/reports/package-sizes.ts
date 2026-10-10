import type { PackageSizes } from "../../lenses/package-sizes-types";
import type { RenderDensity } from "../context";
import { LISTED_AT_DENSITY } from "../context";
import { count } from "../format";
import type { BlockView, ReportView } from "../views";

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
  const ranked = [...packages].sort(
    (a, b) => b.modules.total - a.modules.total || a.id.localeCompare(b.id)
  );
  const shown = ranked.slice(0, LISTED_AT_DENSITY[density]);
  const list: BlockView = {
    items: shown.map((pkg) => ({
      detail: [pkg.layer === null ? "no layer" : `layer ${pkg.layer}`],
      label: pkg.id,
      value: pkg.modules.total,
    })),
    kind: "rankedList",
    ...(ranked.length > shown.length && {
      overflow: ranked.length - shown.length,
    }),
  };
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
      {
        blocks: [list],
        title: "Files by package",
      },
    ],
    title: "Package sizes",
  };
}
