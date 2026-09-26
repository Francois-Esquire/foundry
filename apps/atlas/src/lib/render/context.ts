export type RenderFormat = "terminal" | "text" | "markdown";
export type RenderDensity = "compact" | "normal" | "expanded";

/**
 * Resolved once at the CLI boundary and passed down; nothing under `render/`
 * reads `process` or the terminal. Tests construct it literally.
 */
export interface RenderContext {
  color: boolean;
  density: RenderDensity;
  format: RenderFormat;
  unicode: boolean;
  width: number;
}
