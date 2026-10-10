export const RENDER_FORMATS = ["terminal", "text", "markdown"] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

export const RENDER_DENSITIES = ["compact", "normal", "expanded"] as const;
export type RenderDensity = (typeof RENDER_DENSITIES)[number];

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
