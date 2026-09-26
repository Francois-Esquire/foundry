import type { RenderContext } from "./context";
import { barCells, labelCells, wrapCells } from "./layout";
import { createRenderer } from "./primitives";
import type { Renderer } from "./renderer";
import { colorTheme, glyphsFor, plainTheme } from "./theme";

export function createTerminalRenderer(context: RenderContext): Renderer {
  return createRenderer({
    barCells: barCells(context.width),
    glyphs: glyphsFor(context.unicode),
    labelCells: labelCells(context.width),
    theme: context.color ? colorTheme() : plainTheme,
    wrapCells: wrapCells(context.width),
  });
}
