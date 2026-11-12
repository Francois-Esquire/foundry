import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { RECORDED_LABEL } from "~/generate/provenance-facts";
import { ResultBoard } from "~/generate/script-extension/result-board";
import { shownExtension } from "~/generate/script-extension/shown-extension";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import type { Face } from "~/typeface/face";
import { EMPTY_OUTLINE } from "~/typeface/outline";
import { fixtureFace } from "../../helpers/faces";

const face: Face = {
  description: fixtureFace("lato").description,
  id: "lato",
  index: 0,
  sourceId: "lato",
};

it("draws project glyphs without claiming findings the page does not have", () => {
  const shown = shownExtension(
    [
      {
        advance: 432,
        characters: [65],
        key: "project-key",
        name: "ka-deva",
        outline: EMPTY_OUTLINE,
        provenance: { origin: "manual" },
      },
    ],
    plan
  );
  const html = renderToStaticMarkup(
    createElement(ResultBoard, {
      face,
      inFace: false,
      shown,
    })
  );
  expect(html).toContain('data-glyph="ka-deva"');
  expect(html).toContain("U+0041");
  expect(html).toContain("Advance 432.");
  expect(html).not.toContain(`${RECORDED_LABEL}, replayed`);
  expect(html).not.toContain("Not evaluated.");
  expect(html).not.toContain("Made by");
  expect(html).not.toContain("Why it was not made");
});
