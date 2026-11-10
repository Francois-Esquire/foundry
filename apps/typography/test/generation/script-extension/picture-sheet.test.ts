/**
 * The same extension when a sheet arrives as a picture. The syllables sheet
 * of the recorded run is painted to pixels here, so its glyphs have to be
 * traced before anything is separated. No model made the picture: its
 * manifest entry is marked synthetic and its glyphs name no model.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { type Bitmap, createBitmap } from "~/generation/raster/bitmap";
import { flattenOutline } from "~/generation/raster/flatten";
import { rasterizePolygons } from "~/generation/raster/rasterize";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import {
  extendScript,
  type ScriptExtension,
} from "~/generation/script-extension/extend";
import { inkToImage } from "~/generation/sheet/drawing";
import {
  loadRecordedRuns,
  type RecordedRunManifest,
} from "~/generation/strategies/recorded/manifest";
import { parseSvg } from "~/generation/vector/svg/document";
import { outlineBounds, transformOutline } from "~/typeface/outline";
import { nodeImageCodec } from "../../../scripts/generation/node-image-codec";
import { fixtureFace } from "../helpers/glyphs";
import {
  loadSubsetRuns,
  sheetsOf,
  subsetManifest,
  subsetRunFiles,
} from "./helpers/subset";

const PICTURE_WIDTH = 1536;
const DARK = 0.5;

/** Paints an SVG sheet's shapes in order: dark ones are ink, light ones wipe it out. */
const paintSheet = (svg: string): Bitmap => {
  const { shapes, viewBox } = parseSvg(svg);
  const scale = PICTURE_WIDTH / viewBox.width;
  const sheet = createBitmap(PICTURE_WIDTH, Math.round(viewBox.height * scale));
  for (const shape of shapes) {
    const layer = rasterizePolygons(
      flattenOutline(
        transformOutline(shape.outline, {
          dx: -viewBox.x * scale,
          dy: -viewBox.y * scale,
          xx: scale,
          xy: 0,
          yx: 0,
          yy: scale,
        }),
        0.05
      ),
      sheet.width,
      sheet.height,
      { antialias: true }
    );
    for (const [index, cover] of layer.data.entries()) {
      const under = sheet.data[index] ?? 0;
      sheet.data[index] =
        shape.darkness >= DARK
          ? Math.max(under, cover)
          : Math.round((under * (255 - cover)) / 255);
    }
  }
  return sheet;
};

/** Painting, tracing and two extensions can outlast the default hook limit. */
const SETUP_TIMEOUT = 120_000;

describe("separating marks when the syllables sheet is a picture", () => {
  const face = fixtureFace("lato");
  let fromCurves: ScriptExtension;
  let fromPixels: ScriptExtension;

  beforeAll(async () => {
    const files = subsetRunFiles();
    const manifest = JSON.parse(subsetManifest()) as RecordedRunManifest;
    const syllables = manifest.outputs.find(
      (output) => output.name === "syllables"
    );
    if (!syllables) {
      throw new Error("The recorded run has no syllables sheet.");
    }
    const svg = new TextDecoder().decode(files.get(syllables.file));
    files.set(
      "syllables.png",
      await nodeImageCodec.encodePng(inkToImage(paintSheet(svg)))
    );
    const painted: RecordedRunManifest = {
      ...manifest,
      outputs: manifest.outputs.map((output) =>
        output === syllables
          ? {
              ...output,
              file: "syllables.png",
              kind: "sheet-image",
              synthetic: true,
            }
          : output
      ),
    };
    fromPixels = await extendScript({
      codec: nodeImageCodec,
      face,
      faceId: "lato",
      plan,
      sheets: sheetsOf(loadRecordedRuns(JSON.stringify(painted), files)),
    });
    fromCurves = await extendScript({
      face,
      faceId: "lato",
      plan,
      sheets: sheetsOf(loadSubsetRuns()),
    });
  }, SETUP_TIMEOUT);

  it("makes every planned glyph, and attributes the painted sheet's to no model", () => {
    expect(fromPixels.missing).toEqual([]);
    const sign = fromPixels.glyphs.find(
      (glyph) => glyph.planned.name === "aaMatra-deva"
    );
    expect(sign?.madeBy).toContain("traced from the pixels");
    expect(sign?.provenance).toMatchObject({
      origin: "generated",
      strategy: "synthetic-sheet",
    });
    expect(sign?.provenance).not.toHaveProperty("model");
  });

  it.each(plan.glyphs.filter((glyph) => glyph.shownIn))(
    "separates $name as it does from the model's own curves",
    (planned) => {
      const find = (extension: ScriptExtension) =>
        extension.glyphs.find((glyph) => glyph.planned.name === planned.name);
      const pixels = find(fromPixels);
      const curves = find(fromCurves);
      const a = pixels && outlineBounds(pixels.outline);
      const b = curves && outlineBounds(curves.outline);
      if (!(pixels && curves && a && b)) {
        throw new Error(`${planned.name} was not made both ways.`);
      }
      // A picture at this size has a pixel about twelve font units wide.
      const close = 30;
      expect(Math.abs(pixels.advance - curves.advance)).toBeLessThanOrEqual(
        close
      );
      for (const edge of ["xMin", "xMax", "yMin", "yMax"] as const) {
        expect(Math.abs(a[edge] - b[edge]), edge).toBeLessThanOrEqual(close);
      }
    }
  );
});
