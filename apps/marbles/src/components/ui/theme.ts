export interface Palette {
  readonly border: {
    readonly color: string;
    readonly focusColor: string;
    readonly style: "rounded" | "heavy";
  };
  readonly colors: {
    readonly accent: string;
    readonly background: string;
    readonly error: string;
    readonly foreground: string;
    readonly info: string;
    readonly muted: string;
    readonly mutedForeground: string;
    readonly primary: string;
    readonly primaryForeground: string;
    readonly secondary: string;
    readonly success: string;
    readonly warning: string;
  };
}

export const BUILT_IN_PALETTES: Readonly<Record<"dark" | "light", Palette>> = {
  dark: {
    border: { color: "#665c54", focusColor: "#fabd2f", style: "rounded" },
    colors: {
      accent: "#8ec07c",
      background: "#282828",
      error: "#fb4934",
      foreground: "#ebdbb2",
      info: "#83a598",
      muted: "#3c3836",
      mutedForeground: "#a89984",
      primary: "#fabd2f",
      primaryForeground: "#282828",
      secondary: "#d3869b",
      success: "#b8bb26",
      warning: "#fabd2f",
    },
  },
  light: {
    border: { color: "#bdae93", focusColor: "#b57614", style: "rounded" },
    colors: {
      accent: "#427b58",
      background: "#fbf1c7",
      error: "#9d0006",
      foreground: "#3c3836",
      info: "#076678",
      muted: "#ebdbb2",
      mutedForeground: "#7c6f64",
      primary: "#b57614",
      primaryForeground: "#fbf1c7",
      secondary: "#8f3f71",
      success: "#79740e",
      warning: "#b57614",
    },
  },
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const theme: {
  readonly border: Mutable<Palette["border"]>;
  readonly colors: Mutable<Palette["colors"]>;
} = {
  border: { ...BUILT_IN_PALETTES.dark.border },
  colors: { ...BUILT_IN_PALETTES.dark.colors },
};

export function applyPalette(palette: Palette): void {
  Object.assign(theme.border, palette.border);
  Object.assign(theme.colors, palette.colors);
}
