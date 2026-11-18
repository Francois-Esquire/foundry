import {
  createContext,
  type PropsWithChildren,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { worksApi } from "~/app/api/client";
import { useReducedStream } from "~/app/lib/use-reduced-stream";
import {
  isThemeMode,
  type ThemeAppearance,
  type ThemeMode,
  type ThemeSnapshot,
} from "~/shared/theme";

export type { ThemeMode } from "~/shared/theme";
export type ResolvedTheme = ThemeAppearance;

export const THEME_MODE_STORAGE_KEY = "theme-mode";

function readStoredPreference(): ThemeMode | null {
  try {
    const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    return isThemeMode(stored) ? stored : null;
  } catch {
    return null;
  }
}

function readStoredMode(): ThemeMode {
  return readStoredPreference() ?? "auto";
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

async function openMainTheme(signal: AbortSignal) {
  const { theme } = worksApi();
  await theme.adopt.call({ mode: readStoredPreference() }, { signal });
  return await theme.watch.call(undefined, { signal });
}

function followSnapshot(
  _previous: ThemeSnapshot | null,
  snapshot: ThemeSnapshot
): ThemeSnapshot {
  storeMode(snapshot.mode);
  return snapshot;
}

interface Choice {
  readonly after: number;
  readonly mode: ThemeMode;
  readonly refused: boolean;
}

function shownMode(
  choice: Choice | null,
  snapshot: ThemeSnapshot | null,
  stored: ThemeMode
): ThemeMode {
  const waiting =
    choice !== null &&
    !choice.refused &&
    choice.after >= (snapshot?.revision ?? -1);
  if (choice && waiting) {
    return choice.mode;
  }
  return snapshot?.mode ?? choice?.mode ?? stored;
}

export interface ThemeContextValue {
  resolvedTheme: ResolvedTheme;
  setTheme: (mode: ThemeMode) => void;
  themeMode: ThemeMode;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  const [stored] = useState<ThemeMode>(readStoredMode);
  const [choice, setChoice] = useState<Choice | null>(null);
  const { state: snapshot } = useReducedStream({
    initial: null,
    open: openMainTheme,
    reduce: followSnapshot,
  });
  const themeMode = shownMode(choice, snapshot, stored);
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

  const revision = snapshot?.revision ?? -1;
  const setTheme = useCallback(
    (mode: ThemeMode) => {
      const chosen: Choice = { after: revision, mode, refused: false };
      setChoice(chosen);
      worksApi()
        .theme.set.call({ mode })
        .catch(() => {
          setChoice((current) =>
            current === chosen ? { ...chosen, refused: true } : current
          );
        });
    },
    [revision]
  );

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
