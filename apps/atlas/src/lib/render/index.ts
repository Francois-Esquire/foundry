import type { ApplyResult, PlanSiteResult } from "../codemod-types";
import type { AnalysisConfig } from "../config";
import { ANALYSIS_CONFIG } from "../config";
import type { LensId, LensOutputs } from "../lenses/lens-types";
import type { SurfaceReport } from "../types";
import type { RenderContext } from "./context";
import { createMarkdownRenderer } from "./markdown";
import type { Renderer } from "./renderer";
import { buildApplyView } from "./reports/apply";
import { buildPlanView } from "./reports/codemod";
import { LENS_VIEWS } from "./reports/lenses";
import { buildSurfaceView } from "./reports/surface";
import { createTerminalRenderer } from "./terminal";
import { createTextRenderer } from "./text";
import type { ReportView } from "./views";

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

function renderView(
  view: (density: RenderContext["density"]) => ReportView,
  overrides: Partial<RenderContext>
): string {
  const context: RenderContext = { ...DEFAULT_CONTEXT, ...overrides };
  return rendererFor(context).report(view(context.density));
}

export function renderSurface(
  report: SurfaceReport,
  options: RenderOptions = {}
): string {
  const { config = ANALYSIS_CONFIG, ...overrides } = options;
  return renderView(
    (density) => buildSurfaceView(report, config, density),
    overrides
  );
}

/** One lens's output, through the lens's report view. */
export function renderLens<I extends LensId>(
  id: I,
  output: LensOutputs[I],
  options: Partial<RenderContext> = {}
): string {
  return renderView((density) => LENS_VIEWS[id](output, density), options);
}

/** `atlas plan`'s result, through the plan's report view. */
export function renderPlan(
  result: PlanSiteResult,
  options: Partial<RenderContext> = {}
): string {
  return renderView((density) => buildPlanView(result, density), options);
}

/** `atlas apply`'s result, through the apply's report view. */
export function renderApply(
  result: ApplyResult,
  options: Partial<RenderContext> = {}
): string {
  return renderView((density) => buildApplyView(result, density), options);
}
