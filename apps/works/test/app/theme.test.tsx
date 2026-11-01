import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorksApi } from "~/app/api/client";
import {
  applyStoredTheme,
  THEME_MODE_STORAGE_KEY,
  type ThemeContextValue,
  ThemeProvider,
  useTheme,
} from "~/app/theme/theme";
import { SystemTheme } from "~/main/system/theme";
import { fakeApi, openFakeVault } from "../helpers/fake-api";
import { fakeNativeTheme } from "../helpers/native-theme";

const client = vi.hoisted(() => ({ api: undefined as WorksApi | undefined }));

vi.mock("~/app/api/client", () => ({ worksApi: () => client.api }));

let captured: ThemeContextValue | null = null;

function Probe() {
  captured = useTheme();
  return null;
}

/** Main's theme over a fresh preference file, served to the renderer. */
async function mainTheme(stored?: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "works-theme-"));
  const file = path.join(directory, "theme.json");
  if (stored) {
    await writeFile(
      file,
      JSON.stringify({ format: "works.theme/1", mode: stored })
    );
  }
  const theme = new SystemTheme();
  await theme.open({ file, native: fakeNativeTheme().native });
  client.api = fakeApi(await openFakeVault(), undefined, { theme });
  return { file, theme };
}

describe("theme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = "";
    captured = null;
    client.api = undefined;
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

  it("hands main the stored mode on first run", async () => {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, "dark");
    const { file, theme } = await mainTheme();

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    await waitFor(() => expect(theme.snapshot()?.mode).toBe("dark"));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      format: "works.theme/1",
      mode: "dark",
    });
    expect(captured?.themeMode).toBe("dark");
  });

  it("follows main's stored preference over the renderer's cache later on", async () => {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, "dark");
    const { theme } = await mainTheme("light");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    await waitFor(() => expect(captured?.themeMode).toBe("light"));
    expect(theme.snapshot()?.mode).toBe("light");
    expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);

    // A change made in main reaches the selector.
    await act(() => theme.set("dark"));
    await waitFor(() => expect(captured?.themeMode).toBe("dark"));
  });

  it("follows main again after the theme stream drops", async () => {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, "dark");
    const { theme } = await mainTheme("light");
    const watch = theme.watch.bind(theme);
    let drops = 1;
    vi.spyOn(theme, "watch").mockImplementation((signal) => {
      if (drops > 0) {
        drops -= 1;
        throw new Error("The theme stream dropped");
      }
      return watch(signal);
    });

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    expect(captured?.themeMode).toBe("dark");
    await waitFor(() => expect(captured?.themeMode).toBe("light"), {
      timeout: 5000,
    });
    expect(theme.watch).toHaveBeenCalledTimes(2);
  });

  it("sets an explicit choice in main and updates the document", async () => {
    const { theme } = await mainTheme("auto");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    await waitFor(() => expect(theme.subscribers).toBe(1));

    act(() => {
      captured?.setTheme("dark");
    });

    expect(captured?.themeMode).toBe("dark");
    expect(captured?.resolvedTheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await waitFor(() => expect(theme.snapshot()?.mode).toBe("dark"));
    // Cached for the next launch's first paint once main has it.
    await waitFor(() =>
      expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe("dark")
    );
    cleanup();
    await waitFor(() => expect(theme.subscribers).toBe(0));
  });

  it("shows main's mode again when main refuses a choice", async () => {
    const { theme } = await mainTheme("light");
    vi.spyOn(theme, "set").mockRejectedValueOnce(
      new Error("The theme could not be saved")
    );
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    await waitFor(() => expect(captured?.themeMode).toBe("light"));

    act(() => {
      captured?.setTheme("dark");
    });

    expect(captured?.themeMode).toBe("dark");
    await waitFor(() => expect(captured?.themeMode).toBe("light"));
    expect(theme.snapshot()?.mode).toBe("light");
    expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("keeps the local mode when main's theme is unavailable", async () => {
    client.api = fakeApi(await openFakeVault());
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, "sideways");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    expect(captured?.themeMode).toBe("auto");
    expect(document.documentElement.classList.contains("auto")).toBe(true);
    act(() => {
      captured?.setTheme("light");
    });
    expect(captured?.themeMode).toBe("light");
  });
});
