import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parseArgs } from "~/cli/args";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  settingsPath,
} from "~/cli/settings";
import { applyTheme, settingsView, terminalTheme } from "~/cli/theme";
import { theme } from "~/components/ui/theme";
import { THEME_NAMES } from "~/model/settings";

let state: string;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "marbles-settings-"));
});

afterEach(async () => {
  applyTheme("dark");
  await rm(state, { force: true, recursive: true });
});

function withFoundryHome(value: string | undefined, body: () => void): void {
  const previous = process.env.FOUNDRY_HOME;
  if (value === undefined) {
    delete process.env.FOUNDRY_HOME;
  } else {
    process.env.FOUNDRY_HOME = value;
  }
  try {
    body();
  } finally {
    if (previous === undefined) {
      delete process.env.FOUNDRY_HOME;
    } else {
      process.env.FOUNDRY_HOME = previous;
    }
  }
}

it("lives at the state root: ~/.foundry/marbles by default", () => {
  withFoundryHome(undefined, () => {
    expect(settingsPath(parseArgs([]).state)).toBe(
      join(homedir(), ".foundry", "marbles", "settings.json")
    );
  });
});

it("follows FOUNDRY_HOME", () => {
  const home = join(state, "home");
  withFoundryHome(home, () => {
    expect(settingsPath(parseArgs([]).state)).toBe(
      join(home, "marbles", "settings.json")
    );
  });
});

it("uses defaults without a file, and round-trips a saved theme", async () => {
  const path = settingsPath(state);
  expect(loadSettings(path)).toEqual({ path, settings: DEFAULT_SETTINGS });
  expect(saveSettings(path, { theme: "light" })).toEqual({ theme: "light" });
  expect(loadSettings(path)).toEqual({ path, settings: { theme: "light" } });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "light" });
});

it("keeps keys it does not know when it saves", async () => {
  const path = settingsPath(state);
  await writeFile(path, JSON.stringify({ future: { a: 1 }, theme: "dark" }));
  saveSettings(path, { theme: "light" });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    future: { a: 1 },
    theme: "light",
  });
});

it("falls back to the default theme for a value it does not know, and says why", async () => {
  const path = settingsPath(state);
  await writeFile(path, JSON.stringify({ theme: "nonexistent" }));
  const loaded = loadSettings(path);
  expect(loaded.settings).toEqual(DEFAULT_SETTINGS);
  expect(loaded.problem).toContain('theme "nonexistent"');
});

it("lists all bundled themes and gets and sets the active theme from the CLI", () => {
  const cli = (...args: string[]) =>
    spawnSync([process.execPath, "src/cli.ts", "settings", ...args], {
      env: { ...process.env, FOUNDRY_HOME: state },
    });
  const listed = cli("themes");
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout.toString().trim().split("\n")).toEqual(THEME_NAMES);
  expect(THEME_NAMES).toHaveLength(42);
  expect(cli("set", "theme", "opencode").exitCode).toBe(0);
  expect(cli("get", "theme").stdout.toString().trim()).toBe("opencode");
  expect(cli("set", "theme", "dark", "--dry-run").exitCode).toBe(1);
  expect(
    loadSettings(settingsPath(join(state, "marbles"))).settings.theme
  ).toBe("opencode");
}, 15_000);

it("ignores an unreadable file, and refuses to overwrite it", async () => {
  const path = settingsPath(state);
  for (const content of ["{not json", "[1, 2]"]) {
    await writeFile(path, content);
    const loaded = loadSettings(path);
    expect(loaded.settings).toEqual(DEFAULT_SETTINGS);
    expect(loaded.problem).toContain("using defaults");
    expect(() => saveSettings(path, { theme: "light" })).toThrow(
      "fix or remove it"
    );
    expect(await readFile(path, "utf8")).toBe(content);
  }
});

it("applies a theme in place, and the default palette is unchanged", () => {
  expect(theme.colors.background).toBe("#282828");
  expect(theme.colors.warning).toBe("#fabd2f");
  applyTheme("light");
  expect(theme.colors.background).toBe("#fbf1c7");
  applyTheme("dark");
  expect(theme.colors.background).toBe("#282828");
});

it("lists every theme with its label and swatches for the settings panel", () => {
  const view = settingsView({ path: "settings.json", theme: "light" });
  expect(view).toMatchObject({
    label: "Light",
    path: "settings.json",
    theme: "light",
  });
  expect(view.themes.map(({ name }) => name)).toEqual(THEME_NAMES);
  const { colors } = terminalTheme("light");
  expect(view.themes[1]).toEqual({
    label: "Light",
    name: "light",
    swatches: {
      accent: colors.accent,
      background: colors.background,
      primary: colors.primary,
    },
  });
});
