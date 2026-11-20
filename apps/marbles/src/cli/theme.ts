import type {
  SettingsView,
  ThemeChoice,
} from "~/components/blocks/settings-panel";
import {
  applyPalette,
  BUILT_IN_PALETTES,
  type Palette,
} from "~/components/ui/theme";
import {
  type SettingsSnapshot,
  THEME_NAMES,
  type ThemeName,
  themeLabel,
} from "~/model/settings";
import termcnThemes from "~/model/termcn-themes.json";

function builtIn(name: ThemeName): name is "dark" | "light" {
  return name === "dark" || name === "light";
}

export function terminalTheme(name: ThemeName) {
  if (builtIn(name)) {
    const palette = BUILT_IN_PALETTES[name];
    return {
      border: palette.border,
      colors: { ...termcnThemes.default.colors, ...palette.colors },
    };
  }
  const { colors, border } = termcnThemes[name];
  const style: Palette["border"]["style"] =
    border.style === "heavy" ? "heavy" : "rounded";
  return {
    border: { ...border, style },
    colors,
  };
}

export function applyTheme(name: ThemeName): void {
  const palette = terminalTheme(name);
  applyPalette({
    border: palette.border,
    colors: {
      ...palette.colors,
      secondary: builtIn(name)
        ? palette.colors.secondary
        : palette.colors.accent,
    },
  });
}

function themeChoice(name: ThemeName): ThemeChoice {
  const { colors } = terminalTheme(name);
  return {
    label: themeLabel(name),
    name,
    swatches: {
      accent: colors.accent,
      background: colors.background,
      primary: colors.primary,
    },
  };
}

export function settingsView(settings: SettingsSnapshot): SettingsView {
  return {
    ...settings,
    label: themeLabel(settings.theme),
    themes: THEME_NAMES.map(themeChoice),
  };
}
