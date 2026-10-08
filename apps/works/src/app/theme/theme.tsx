import {
  createContext,
  type PropsWithChildren,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemeMode = "auto" | "dark" | "light";
export type ResolvedTheme = Exclude<ThemeMode, "auto">;

/** Where the chosen mode is cached so the next launch can paint it before React mounts. */
export const THEME_MODE_STORAGE_KEY = "theme-mode";

const THEME_MODES: readonly ThemeMode[] = ["auto", "dark", "light"];

function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_MODES.some((mode) => mode === value);
}

function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    return isThemeMode(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

function storeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // No storage: the next launch paints from the desktop appearance.
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === "auto" ? systemTheme() : mode;
}

function applyThemeClass(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.classList.remove("light", "dark", "auto");
  root.classList.add(resolved);
  if (mode === "auto") {
    root.classList.add("auto");
  }
  return resolved;
}

/**
 * Put the stored theme on the document before React mounts, so the first
 * paint is already the right colour instead of being corrected afterwards.
 */
export function applyStoredTheme(): void {
  applyThemeClass(readStoredMode());
}

export interface ThemeContextValue {
  resolvedTheme: ResolvedTheme;
  setTheme: (mode: ThemeMode) => void;
  themeMode: ThemeMode;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readStoredMode);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(themeMode)
  );

  useEffect(() => {
    setResolvedTheme(applyThemeClass(themeMode));
    if (themeMode !== "auto") {
      return;
    }
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => {
      setResolvedTheme(applyThemeClass("auto"));
    };
    query.addEventListener("change", follow);
    return () => {
      query.removeEventListener("change", follow);
    };
  }, [themeMode]);

  const setTheme = useCallback((mode: ThemeMode) => {
    storeMode(mode);
    setThemeMode(mode);
  }, []);

  const value = useMemo(
    () => ({ resolvedTheme, setTheme, themeMode }),
    [resolvedTheme, setTheme, themeMode]
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext);
  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
