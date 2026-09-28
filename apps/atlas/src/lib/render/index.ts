import type { AnalysisConfig } from "../config";
import { ANALYSIS_CONFIG } from "../config";
import type { SurfaceReport } from "../types";
import type { RenderContext } from "./context";
import { createMarkdownRenderer } from "./markdown";
import type { Renderer } from "./renderer";
import { buildSurfaceView } from "./reports/surface";
import { createTerminalRenderer } from "./terminal";
import { createTextRenderer } from "./text";

export interface RenderOptions extends Partial<RenderContext> {
  config?: AnalysisConfig;
}

export const DEFAULT_CONTEXT: RenderContext = {
  color: false,
  density: "normal",
  format: "text",
  unicode: true,
  width: 80,
};

function rendererFor(context: RenderContext): Renderer {
  switch (context.format) {
    case "terminal":
      return createTerminalRenderer(context);
    case "markdown":
      return createMarkdownRenderer();
    case "text":
      return createTextRenderer(context);
    default:
      throw new Error("Unexpected context.format.");
  }
}

export function renderSurface(
  report: SurfaceReport,
  options: RenderOptions = {}
): string {
  const { config = ANALYSIS_CONFIG, ...overrides } = options;
  const context: RenderContext = { ...DEFAULT_CONTEXT, ...overrides };
  return rendererFor(context).report(
    buildSurfaceView(report, config, context.density)
  );
}
