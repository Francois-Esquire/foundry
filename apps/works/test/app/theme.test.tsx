import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStoredTheme,
  THEME_MODE_STORAGE_KEY,
  type ThemeContextValue,
  ThemeProvider,
  useTheme,
} from "~/app/theme/theme";

let captured: ThemeContextValue | null = null;

function Probe() {
  captured = useTheme();
  return null;
}

describe("theme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = "";
    captured = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("paints the stored mode before React mounts", () => {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, "dark");

    applyStoredTheme();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("auto")).toBe(false);
  });

  it("stores an explicit choice and updates the document", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    act(() => {
      captured?.setTheme("dark");
    });

    expect(captured?.themeMode).toBe("dark");
    expect(captured?.resolvedTheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("falls back to auto for a garbage stored value", () => {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, "sideways");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    expect(captured?.themeMode).toBe("auto");
    expect(document.documentElement.classList.contains("auto")).toBe(true);
  });
});
