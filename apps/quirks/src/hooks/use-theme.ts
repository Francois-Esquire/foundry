// Adapted from termcn.
import { createContext, useContext } from "react";
import { defaultTheme } from "~/components/ui/theme";

const ThemeContext = createContext(defaultTheme);

export function useTheme() {
  return useContext(ThemeContext);
}
