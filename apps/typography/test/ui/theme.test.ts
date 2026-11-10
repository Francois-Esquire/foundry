/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "typography.theme";

const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
};

const blockedStorage = {
  getItem: () => {
    throw new Error("Storage is blocked.");
  },
  setItem: () => {
    throw new Error("Storage is blocked.");
  },
};

/** The theme is module state, so each visit gets a fresh module. */
const visit = () => {
  vi.resetModules();
  return import("~/ui/theme");
};

const shown = () => document.documentElement.dataset.theme;

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme", () => {
  it("starts on white tape", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { startTheme, THEME_STORAGE_KEY } = await visit();
    startTheme();
    expect(shown()).toBe("white");
    expect(THEME_STORAGE_KEY).toBe(KEY);
  });

  it("remembers the choice on the next visit", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const first = await visit();
    first.setTheme("black");
    expect(shown()).toBe("black");
    expect(storage.getItem(KEY)).toBe("black");

    document.documentElement.removeAttribute("data-theme");
    const second = await visit();
    second.startTheme();
    expect(shown()).toBe("black");
  });

  it("falls back to white tape for a stored value it does not know", async () => {
    const storage = memoryStorage();
    storage.setItem(KEY, "sepia");
    vi.stubGlobal("localStorage", storage);
    const { startTheme } = await visit();
    startTheme();
    expect(shown()).toBe("white");
  });

  it("still switches when storage is blocked", async () => {
    vi.stubGlobal("localStorage", blockedStorage);
    const { setTheme, startTheme } = await visit();
    startTheme();
    expect(shown()).toBe("white");
    setTheme("black");
    expect(shown()).toBe("black");
  });
});
