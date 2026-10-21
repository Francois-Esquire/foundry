import type { DatasetReader } from "../dataset";
import type { VisualizationInput } from "./types";

/** Scan-time visualization reads analysis artifacts, never viewer state or GPU resources. */
export async function readVisualizationInput(
  reader: DatasetReader
): Promise<VisualizationInput> {
  const [index, graph, sizes, inventory] = await Promise.all([
    reader.moduleIndex(),
    reader.dependencyGraph(),
    reader.lens("package-sizes"),
    reader.dependencyInventory(),
  ]);
  return {
    modules: index.modules.map((module) => {
      const position = module.mapPosition;
      if (
        position === undefined ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y)
      ) {
        throw new Error(
          `Cannot prepare visualization: module ${module.id} has no finite saved map position.`
        );
      }
      return {
        id: module.id,
        package: module.package,
        x: position.x,
        y: position.y,
      };
    }),
    packages: sizes.packages.map((pkg) => ({
      id: pkg.id,
      layer: pkg.layer,
      size: pkg.modules.total,
    })),
    routes: graph.edges.flatMap((edge) =>
      edge.kind === "dependency"
        ? [
            {
              from: edge.from,
              to: edge.to,
              weight: edge.dependency.moduleEdges,
            },
          ]
        : []
    ),
    ...(inventory !== undefined && { inventory }),
  };
}
