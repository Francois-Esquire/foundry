/**
 * The screen terrain's clipmap: nested square levels of the terrain, each
 * the same number of texels a side and each twice the map units a texel of
 * the one inside it, centred on the camera. A pixel reads the level whose
 * texel is about its own footprint, so the terrain holds one sample a
 * screen pixel at any zoom while the whole clipmap stays a few million
 * texels. Positions here are map units, x right and y down the chart, as
 * the world grid's are; nothing here touches the GPU, so the shader's level
 * choice has a CPU twin to test against.
 */
export interface ClipmapSettings {
  /** Texels a level's edge keeps clear of the pixels it serves: room for filtering and the derived pass's neighbours. */
  edge: number;
  /** Texels inside a level's usable edge over which it hands over to the next coarser level. */
  fade: number;
  /** Map units a texel of the finest level spans. */
  finest: number;
  /** How many levels, finest first. */
  levels: number;
  /** Texels along each side of a level. */
  resolution: number;
  /**
   * Texels a level's centre snaps to: a level is re-centred, and baked
   * again, only once the camera has moved this far in its own texels, so a
   * small pan bakes nothing and the texel grid never swims under the view.
   */
  snap: number;
}

/**
 * Six levels of 1,024² from a quarter of a map unit a texel: the finest
 * spans 256 map units, an island close up; the coarsest 8,192, more than
 * the whole sea, so no pixel ever falls outside the clipmap.
 */
export const defaultClipmapSettings: ClipmapSettings = {
  edge: 4,
  fade: 48,
  finest: 0.25,
  levels: 6,
  resolution: 1024,
  snap: 64,
};

/** One level placed over the map. */
export interface ClipmapLevel {
  /** Map position of the level's centre, a whole number of snaps. */
  centreX: number;
  centreY: number;
  index: number;
  /** Map position of the level's west and north edges. */
  left: number;
  /** Map units a texel spans. */
  texel: number;
  top: number;
}

/** Map units a texel of level `index` spans. */
function levelTexel(settings: ClipmapSettings, index: number): number {
  return settings.finest * 2 ** index;
}

/** One level centred on a map position, snapped to whole snaps of its texel. */
export function clipmapLevel(
  settings: ClipmapSettings,
  index: number,
  target: { x: number; y: number }
): ClipmapLevel {
  const texel = levelTexel(settings, index);
  const step = settings.snap * texel;
  const centreX = Math.round(target.x / step) * step;
  const centreY = Math.round(target.y / step) * step;
  const half = (settings.resolution / 2) * texel;
  return {
    centreX,
    centreY,
    index,
    left: centreX - half,
    texel,
    top: centreY - half,
  };
}

/** Every level centred on a map position, finest first. */
export function clipmapLayout(
  settings: ClipmapSettings,
  target: { x: number; y: number }
): ClipmapLevel[] {
  return Array.from({ length: settings.levels }, (_, index) =>
    clipmapLevel(settings, index, target)
  );
}

/**
 * The continuous level a footprint asks for: 0 where a pixel spans the
 * finest texel, one more for each doubling. `footprint` is map units a
 * device pixel.
 */
function footprintLevel(settings: ClipmapSettings, footprint: number): number {
  return Math.log2(Math.max(footprint, 1e-9) / settings.finest);
}

/**
 * The finest level any pixel of a view can read: the camera is
 * orthographic, so one footprint holds across the screen. Finer levels are
 * neither baked nor sampled.
 */
export function finestNeededLevel(
  settings: ClipmapSettings,
  footprint: number
): number {
  return Math.min(
    settings.levels - 1,
    Math.max(0, Math.floor(footprintLevel(settings, footprint)))
  );
}

/**
 * Texels from a map position to where a level stops serving pixels, `edge`
 * inside its border: positive within, negative outside.
 */
export function levelInset(
  settings: ClipmapSettings,
  level: ClipmapLevel,
  x: number,
  y: number
): number {
  const reach = Math.max(
    Math.abs(x - level.centreX),
    Math.abs(y - level.centreY)
  );
  return settings.resolution / 2 - settings.edge - reach / level.texel;
}

/**
 * The continuous level a pixel reads, the CPU twin of the material's
 * choice: the footprint's level, held at least at `finest`, and pushed
 * coarser near each level's edge so that a level hands over to the next
 * across `fade` texels before it ends. The integer part is the finer level
 * sampled, the fraction the coarser one's share.
 */
export function pixelLevel(
  settings: ClipmapSettings,
  levels: readonly ClipmapLevel[],
  point: { footprint: number; x: number; y: number },
  finest = 0
): number {
  // Each level a point is near the edge of, or outside, adds its share:
  // nested levels make the sum the coarsest level the point still needs,
  // continuous across every fade.
  let covered = 0;
  for (const each of levels.slice(0, -1)) {
    covered +=
      1 -
      Math.min(
        1,
        Math.max(
          0,
          levelInset(settings, each, point.x, point.y) / settings.fade
        )
      );
  }
  return Math.min(
    settings.levels - 1,
    Math.max(finest, footprintLevel(settings, point.footprint), covered)
  );
}

/** What a bake was made for: the level's placement and the terrain's content. */
export interface LevelBake {
  centreX: number;
  centreY: number;
  key: string;
}

/**
 * The levels a view needs baked: from the finest it can read to the
 * coarsest, each whose placement or content differs from its last bake.
 * A level the view cannot read stays as it is, stale, until a closer view
 * asks for it.
 */
export function levelsToBake(options: {
  baked: readonly (LevelBake | undefined)[];
  footprint: number;
  key: string;
  levels: readonly ClipmapLevel[];
  settings: ClipmapSettings;
}): number[] {
  const { baked, key, levels, settings } = options;
  const finest = finestNeededLevel(settings, options.footprint);
  return levels
    .filter((level) => {
      const last = baked[level.index];
      return (
        level.index >= finest &&
        !(
          last &&
          last.key === key &&
          last.centreX === level.centreX &&
          last.centreY === level.centreY
        )
      );
    })
    .map((level) => level.index);
}

/** Bytes the clipmap holds on the GPU, at `bytesPerTexel` over every level. */
export function clipmapBytes(
  settings: ClipmapSettings,
  bytesPerTexel: number
): number {
  return settings.resolution ** 2 * settings.levels * bytesPerTexel;
}
