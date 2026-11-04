export const THEME_MODES = ["auto", "light", "dark"] as const;

export const THEME_APPEARANCES = ["light", "dark"] as const;

/** The appearance the user chose: follow the desktop, or always light or dark. */
export type ThemeMode = (typeof THEME_MODES)[number];

/** The appearance in effect. */
export type ThemeAppearance = (typeof THEME_APPEARANCES)[number];

export function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_MODES.some((mode) => mode === value);
}

export function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return THEME_APPEARANCES.some((appearance) => appearance === value);
}

/**
 * Main's theme: the chosen mode, the appearance it produces now, and a
 * revision that advances with every change to either.
 */
export interface ThemeSnapshot {
  readonly effective: ThemeAppearance;
  readonly mode: ThemeMode;
  readonly revision: number;
}
