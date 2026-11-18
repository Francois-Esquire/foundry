export const THEME_NAMES = ["dark", "light"] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

export interface SettingsSnapshot {
  readonly path: string;
  readonly problem?: string;
  readonly theme: ThemeName;
}

export interface SettingsChange {
  readonly theme?: ThemeName;
}
