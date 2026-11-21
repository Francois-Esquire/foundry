import * as React from "react";

import { defaultTheme } from "@/lib/terminal-themes/default";
import type {
  Theme,
  ThemeContextValue,
} from "@/components/ui/types";

export const ThemeContext = React.createContext<ThemeContextValue>({
  setTheme: () => {
  },
  theme: defaultTheme,
});

export const useTheme = (): Theme => React.useContext(ThemeContext).theme;

export const useThemeUpdater = (): ((theme: Theme) => void) =>
  React.useContext(ThemeContext).setTheme;
