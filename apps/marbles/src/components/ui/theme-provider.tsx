import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { ThemeName } from "~/model/settings";
import { terminalTheme } from "./theme";

const ThemeContext = createContext<
  ReturnType<typeof terminalTheme> | undefined
>(undefined);

export function ThemeProvider({
  children,
  name,
}: {
  readonly children: ReactNode;
  readonly name: ThemeName;
}) {
  const palette = useMemo(() => terminalTheme(name), [name]);
  return (
    <ThemeContext.Provider value={palette}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
