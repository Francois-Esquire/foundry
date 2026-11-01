/** The palettes Marbles draws with, in the order Settings offers them. */
export const THEME_NAMES = ["dark", "light"] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

/** Global preferences as the dashboard shows them. */
export interface SettingsSnapshot {
  /** Where they are kept. */
  readonly path: string;
  /** Why the file was not used, when it could not be; defaults apply meanwhile. */
  readonly problem?: string;
  readonly theme: ThemeName;
}

/** What Settings can change. */
export interface SettingsChange {
  readonly theme?: ThemeName;
}
