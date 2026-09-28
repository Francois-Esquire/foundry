import { OrthographicCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { MapLabel } from "../../src/web/exploration";

import {
  fileConnections,
  frameFiles,
  inkView,
  keepSeaInFrame,
  visibleLabels,
  visibleRegionTerritory,
  zoomForPixels,
} from "../../src/web/exploration";
import { loadAtlas } from "../helpers/reference-atlas";

describe("atlas exploration", () => {
  it("finds a region island from zoom and camera position without selection", async () => {
    const data = await loadAtlas();
    const territory = data.territories.find((item) => item.radius > 20);
    if (!territory) {
      throw new Error("Missing territory");
    }
    const view = {
      height: 400,
      pixelsPerUnit: 2,
      width: 500,
      x: territory.x,
      y: territory.y,
    };
    expect(visibleRegionTerritory(data.territories, view)?.id).toBe(
      territory.id
    );
    expect(
      visibleRegionTerritory(data.territories, {
        ...view,
        pixelsPerUnit: 1,
      })
    ).toBeUndefined();
    expect(
      visibleRegionTerritory(data.territories, {
        ...view,
        x: 100_000,
        y: 100_000,
      })
    ).toBeUndefined();
  });
  it("keeps the sea under every viewport edge after pan and zoom", () => {
    const atlasWidth = 1800;
    const atlasHeight = 1500;
    const tilt = 0.7;
    for (const [width, height] of [
      [390, 692],
      [1440, 772],
    ] as const) {
      const aspect = width / height;
      const span =
        Math.max(atlasHeight * Math.cos(tilt), atlasWidth / aspect) * 1.05;
      for (const zoom of [0.65, 3, 12]) {
        for (const pan of [-3000, 3000]) {
          const camera = new OrthographicCamera(
            (-span * aspect) / 2,
            (span * aspect) / 2,
            span / 2,
            -span / 2
          );
          const target = new Vector3(pan, pan, pan / 4);
          camera.position.set(0, -Math.sin(tilt) * 2200, Math.cos(tilt) * 2200);
          camera.position.add(target);
          camera.zoom = zoom;
          const offset = camera.position.clone().sub(target);
          const minZoom = keepSeaInFrame(
            camera,
            target,
            tilt,
            atlasWidth,
            atlasHeight,
            atlasWidth * 0.7,
            atlasHeight * 0.7
          );
          const view = inkView(camera, target, tilt, 0, width);
          expect(camera.zoom).toBeGreaterThanOrEqual(minZoom);
          expect(target.z).toBe(0);
          expect(Math.abs(target.x)).toBeLessThanOrEqual(atlasWidth * 0.35);
          expect(Math.abs(target.y)).toBeLessThanOrEqual(atlasHeight * 0.35);
          expect(
            camera.position.clone().sub(target).distanceTo(offset)
          ).toBeLessThan(1e-8);
          expect(Math.abs(view.x) + view.width / 2).toBeLessThanOrEqual(
            atlasWidth / 2 + 1e-8
          );
          expect(Math.abs(view.y) + view.height / 2).toBeLessThanOrEqual(
            atlasHeight / 2 + 1e-8
          );
        }
      }
    }
  });
  it("allows wide-zoom panning past the old chart bounds without exposing an edge", () => {
    const tilt = 0.7;
    const width = 1800;
    const height = 1500;
    const panRoom = 2.2;
    for (const [viewportWidth, viewportHeight] of [
      [390, 692],
      [1440, 772],
    ] as const) {
      const aspect = viewportWidth / viewportHeight;
      const span = Math.max(height * Math.cos(tilt), width / aspect) * 1.05;
      const camera = new OrthographicCamera(
        (-span * aspect) / 2,
        (span * aspect) / 2,
        span / 2,
        -span / 2
      );
      const target = new Vector3(3000, 3000, 0);
      camera.position.set(0, -Math.sin(tilt) * 2200, Math.cos(tilt) * 2200);
      camera.position.add(target);
      camera.zoom = 0.65;
      keepSeaInFrame(
        camera,
        target,
        tilt,
        width * 1.95 * panRoom,
        height * 1.65 * panRoom,
        Math.max(width, ((camera.right - camera.left) / camera.zoom) * 1.2),
        Math.max(
          height,
          ((camera.top - camera.bottom) / camera.zoom / Math.cos(tilt)) * 1.2
        ),
        panRoom
      );
      const view = inkView(camera, target, tilt, 0, viewportWidth);
      expect(target.x).toBeGreaterThan(width / 2);
      expect(target.y).toBeGreaterThan(height / 2);
      expect(Math.abs(view.x) + view.width / 2).toBeLessThanOrEqual(
        (width * 1.95 * panRoom) / 2
      );
      expect(Math.abs(view.y) + view.height / 2).toBeLessThanOrEqual(
        (height * 1.65 * panRoom) / 2
      );
    }
  });
  it("reaches declaration detail at every viewport size", () => {
    for (const width of [366, 700, 1080, 1600]) {
      const camera = new OrthographicCamera(-1100, 1100, 800, -800);
      camera.zoom = zoomForPixels(camera, width, 10);
      expect(
        inkView(camera, new Vector3(), 0.7, 3.22, width).pixelsPerUnit
      ).toBeCloseTo(10);
      expect(zoomForPixels(camera, width, 24)).toBeGreaterThan(camera.zoom);
    }
  });
  it("covers the viewport after vertical screen-space panning and zooming", () => {
    const tilt = 0.7;
    const elevation = 3.22;
    for (const pan of [-180, 0, 180]) {
      for (const zoom of [0.65, 3, 12]) {
        const camera = new OrthographicCamera(-540, 540, 406, -406, 1, 10_000);
        camera.position.set(0, -Math.sin(tilt) * 2200, Math.cos(tilt) * 2200);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
        const target = new Vector3()
          .setFromMatrixColumn(camera.matrix, 1)
          .multiplyScalar(pan);
        camera.position.add(target);
        camera.zoom = zoom;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        const view = inkView(camera, target, tilt, elevation, 1080);
        for (const sign of [-1, 1]) {
          const corner = new Vector3(
            view.x + (sign * view.width) / 2,
            -view.y + (sign * view.height) / 2,
            elevation
          ).project(camera);
          expect(corner.x).toBeCloseTo(sign, 8);
          expect(corner.y).toBeCloseTo(sign, 8);
        }
      }
    }
  });
  it("frames existing members without moving them", async () => {
    const data = await loadAtlas();
    const files = data.territories
      .find((p) => p.files.length > 10)
      ?.files.slice(0, 10);
    if (!files) {
      throw new Error("Missing populated territory");
    }
    const before = structuredClone(files);
    const frame = frameFiles(files);
    if (!frame) {
      throw new Error("Missing frame");
    }
    for (const file of files) {
      expect(Math.abs(file.x - frame.x)).toBeLessThan(frame.width / 2);
      expect(Math.abs(file.y - frame.y)).toBeLessThan(frame.height / 2);
    }
    expect(files).toEqual(before);
    expect(frameFiles([])).toBeNull();
  });
  it("follows actual directed imports to existing files", async () => {
    const data = await loadAtlas();
    const [edge] = data.fileEdges;
    if (!edge) {
      throw new Error("Missing survey edge");
    }
    const links = fileConnections(data, edge.source);
    expect(
      links.some((l) => l.direction === "Imports" && l.file.id === edge.target)
    ).toBe(true);
    for (const link of links) {
      expect(
        data.fileEdges.some((e) =>
          link.direction === "Imports"
            ? e.source === edge.source && e.target === link.file.id
            : e.target === edge.source && e.source === link.file.id
        )
      ).toBe(true);
    }
    expect(fileConnections(data, "missing")).toEqual([]);
  });
  it("keeps priority labels and rejects overlaps and offscreen labels", async () => {
    const [territory] = (await loadAtlas()).territories;
    if (!territory) {
      throw new Error("Missing territory");
    }
    const label: MapLabel = {
      font: "10px serif",
      height: 10,
      territory,
      text: "first",
      width: 20,
      x: 0,
      y: 0,
    };
    const candidates = [
      label,
      { ...label, text: "overlap", x: 5 },
      { ...label, text: "outside", x: 500 },
      { ...label, text: "separate", x: 35 },
    ];
    expect(
      visibleLabels(candidates, {
        height: 100,
        pixelsPerUnit: 1,
        width: 100,
        x: 0,
        y: 0,
      }).map((l) => l.text)
    ).toEqual(["first", "separate"]);
  });
});
