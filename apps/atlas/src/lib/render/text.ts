import type { RenderContext } from "./context";
import { labelCells, wrapCells } from "./layout";
import { createRenderer } from "./primitives";
import type { Renderer } from "./renderer";
import { glyphsFor, plainTheme } from "./theme";

/** No color, no bars: safe for logs, CI, and redirected output. */
export function createTextRenderer(context: RenderContext): Renderer {
  return createRenderer({
    barCells: 0,
    glyphs: glyphsFor(context.unicode),
    labelCells: labelCells(context.width),
    theme: plainTheme,
    wrapCells: wrapCells(context.width),
  });
}
