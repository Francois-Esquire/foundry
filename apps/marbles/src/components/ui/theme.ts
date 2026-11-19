import type { ThemeName } from "~/model/settings";
import termcnThemes from "~/model/termcn-themes.json";

interface Palette {
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

const PALETTES: Readonly<Record<"dark" | "light", Palette>> = {
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

const TERMINAL_TOKENS = {
  spacing: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 6: 6, 8: 8 },
  typography: { base: "", bold: true, lg: "bold", sm: "dim", xl: "bold" },
};

export function terminalTheme(name: ThemeName) {
  if (name === "dark" || name === "light") {
    const palette = PALETTES[name];
    return {
      border: palette.border,
      colors: { ...termcnThemes.default.colors, ...palette.colors },
      name,
      ...TERMINAL_TOKENS,
    };
  }
  const { colors, border } = termcnThemes[name];
  const style: Palette["border"]["style"] =
    border.style === "heavy" ? "heavy" : "rounded";
  return {
    ...TERMINAL_TOKENS,
    border: { ...border, style },
    colors,
    name,
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const theme: {
  readonly border: Mutable<Palette["border"]>;
  readonly colors: Mutable<Palette["colors"]>;
} = {
  border: { ...PALETTES.dark.border },
  colors: { ...PALETTES.dark.colors },
};

export function applyTheme(name: ThemeName): void {
  const palette = terminalTheme(name);
  Object.assign(theme.border, palette.border);
  Object.assign(theme.colors, palette.colors, {
    secondary:
      name === "dark" || name === "light"
        ? palette.colors.secondary
        : palette.colors.accent,
  });
}
