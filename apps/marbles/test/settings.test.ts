import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parseArgs } from "~/args";
import { applyTheme, theme } from "~/components/ui/theme";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  settingsPath,
} from "~/settings";

let state: string;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "marbles-settings-"));
});

afterEach(async () => {
  applyTheme("dark");
  await rm(state, { force: true, recursive: true });
});

it("lives at the state root: ~/.foundry/marbles by default, beside a custom --state", () => {
  const defaults = parseArgs([]);
  expect(settingsPath(defaults.state)).toBe(
    join(homedir(), ".foundry", "marbles", "settings.json")
  );
  expect(settingsPath(state)).toBe(join(state, "settings.json"));
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
  await writeFile(path, JSON.stringify({ theme: "solarized" }));
  const loaded = loadSettings(path);
  expect(loaded.settings).toEqual(DEFAULT_SETTINGS);
  expect(loaded.problem).toContain('theme "solarized"');
});

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
