import { expect, it } from "vitest";
import { layoutBuildings } from "../../src/web/layout/buildings";
import { dependencyRouteMarks } from "../../src/web/layout/dependency-route-marks";
import { insidePolygons } from "../../src/web/layout/polygons";
import { renderingStudy } from "../../src/web/layout/rendering-study";

it("creates a deterministic, independently mutable island study with twelve coast-contained buildings", () => {
  const data = renderingStudy();
  const next = renderingStudy();
  expect(data).toEqual(next);
  expect(data).not.toBe(next);
  expect(data.territories).toHaveLength(1);
  const [territory] = data.territories;
  if (!territory) {
    throw new Error("The rendering study needs its island.");
  }
  expect(territory.files).toHaveLength(12);
  expect(new Set(territory.files.map((file) => file.id)).size).toBe(12);
  for (const file of territory.files) {
    expect(insidePolygons(file, territory.coast)).toBe(true);
  }
  const buildings = layoutBuildings(data);
  expect(buildings).toHaveLength(12);
  for (const building of buildings) {
    expect(building.x).toBe(territory.x + building.file.x);
    expect(building.y).toBe(territory.y + building.file.y);
    const halfRoof = (building.width * 1.1) / 2;
    for (const dx of [-halfRoof, halfRoof]) {
      for (const dy of [-halfRoof, halfRoof]) {
        expect(
          insidePolygons(
            { x: building.file.x + dx, y: building.file.y + dy },
            territory.coast
          )
        ).toBe(true);
      }
    }
  }
  // Each invocation is isolated from viewer-side layout and selection work.
  territory.files.splice(0, 1);
  expect(next.territories[0]?.files).toHaveLength(12);
});

it("draws exactly the three recorded dependencies at their original module positions", () => {
  const data = renderingStudy();
  expect(data.fileEdges).toEqual([
    { source: "study/harbor.ts", target: "study/coordinates.ts" },
    { source: "study/navigation.ts", target: "study/coordinates.ts" },
    { source: "study/chart.ts", target: "study/coordinates.ts" },
  ]);
  const routes = dependencyRouteMarks(data, null);
  expect(routes).toHaveLength(3);
  expect(
    routes.map((mark) => (mark.kind === "stroke" ? mark.points : null))
  ).toEqual([
    [-25, 26, 4, 3],
    [-30, -22, 4, 3],
    [25, -24, 4, 3],
  ]);
  expect(routes.every((mark) => mark.on === "chart")).toBe(true);
  expect(
    dependencyRouteMarks(
      { ...data, fileEdges: [...data.fileEdges].reverse() },
      null
    )
  ).toEqual(routes);
  expect(dependencyRouteMarks(data, "study/coordinates.ts")).toEqual(routes);
  expect(dependencyRouteMarks(data, "study/harbor.ts")).toEqual([routes[1]]);
  expect(dependencyRouteMarks(data, "study/wind.ts")).toEqual([]);
  const counts = new Map(
    data.territories.flatMap((territory) =>
      territory.files.map((file) => [file.id, file] as const)
    )
  );
  for (const file of counts.values()) {
    expect(file.incoming).toBe(
      data.fileEdges.filter((edge) => edge.target === file.id).length
    );
    expect(file.outgoing).toBe(
      data.fileEdges.filter((edge) => edge.source === file.id).length
    );
  }
});
