export const RENDER_FORMATS = ["terminal", "text", "markdown"] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

export const RENDER_DENSITIES = ["compact", "normal", "expanded"] as const;
export type RenderDensity = (typeof RENDER_DENSITIES)[number];

/** How many entries a lens's ranked list shows at each density. */
export const LISTED_AT_DENSITY: Record<RenderDensity, number> = {
  compact: 5,
  expanded: Number.POSITIVE_INFINITY,
  normal: 10,
};

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
