import { useSyncExternalStore } from "react";

/** White tape is ink on a pale ground. Black tape is the same in reverse. */
export type Theme = "black" | "white";

/** Where the choice is kept between visits. */
export const THEME_STORAGE_KEY = "typography.theme";

const listeners = new Set<() => void>();
let current: Theme | undefined;

const stored = (): Theme => {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "black"
      ? "black"
      : "white";
  } catch {
    // Storage can be blocked. The default theme still works.
    return "white";
  }
};

const currentTheme = (): Theme => {
  current ??= stored();
  return current;
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const setTheme = (theme: Theme) => {
  current = theme;
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The theme still applies for this visit.
  }
  for (const listener of listeners) {
    listener();
  }
};

/** Puts the remembered theme on the document before the first paint. */
export const startTheme = () => {
  document.documentElement.dataset.theme = currentTheme();
};

export const useTheme = (): Theme =>
  useSyncExternalStore(subscribe, currentTheme);
