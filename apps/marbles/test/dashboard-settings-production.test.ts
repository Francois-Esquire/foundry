import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseArgs } from "~/args";
import { applyTheme, theme } from "~/components/ui/theme";
import { runInteractive } from "~/dashboard/command";
import type { WorkspaceConnection, WorkspaceSummary } from "~/model/connection";
import type { DashboardSnapshot } from "~/model/dashboard";
import type { SettingsChange } from "~/model/settings";
import type * as Client from "~/process/client";

/**
 * The dashboard command's own settings action, from a real `runInteractive`
 * against a stand-in terminal and Marbles process: what it saves, what it
 * shows, and how a file it cannot use fails.
 */

interface Captured {
  controller?: AbortController;
  settings?: (changes: SettingsChange) => Promise<void>;
  readonly updates: DashboardSnapshot[];
}

const captured = vi.hoisted((): Captured => ({ updates: [] }));

vi.mock("~/dashboard/terminal", () => ({
  openDashboard: (_name: string, controller: AbortController) => {
    captured.controller = controller;
    return Promise.resolve({
      close: () => undefined,
      connect: (host: {
        settings?: (changes: SettingsChange) => Promise<void>;
      }) => {
        captured.settings = host.settings;
      },
      entry: Promise.resolve(true),
      failure: () => Promise.resolve(),
      onboard: () => Promise.resolve(true),
      update: (snapshot: DashboardSnapshot) => {
        captured.updates.push(snapshot);
      },
    });
  },
}));

// Only `--dry-run` hosts the workspace in this process, through Bun's loader.
vi.mock("~/workspace/host", () => ({ hostWorkspace: vi.fn() }));
vi.mock("~/workspace/open", () => ({ loadSource: vi.fn() }));

vi.mock("~/process/client", async (importOriginal) => ({
  ...(await importOriginal<typeof Client>()),
  connect: () => {
    const summary = (root: string): WorkspaceSummary => ({
      config: null,
      id: "ws",
      root,
      state: "ready",
    });
    let attached: WorkspaceSummary | undefined;
    return Promise.resolve({
      attach: (source: string) => {
        attached = summary(source);
        return Promise.resolve(attached);
      },
      close: () => undefined,
      closed: new Promise(() => undefined),
      subscribe: () => () => undefined,
      workspace: (target: WorkspaceSummary) =>
        ({
          actions: {},
          snapshot: () =>
            Promise.resolve({
              definitions: [],
              feed: [],
              mode: "live",
              runs: [],
              status: "ready",
              triggers: [],
              workspace: "ws",
              workspaceId: target.id,
            }),
        }) as unknown as WorkspaceConnection,
      workspaces: () => Promise.resolve(attached ? [attached] : []),
    });
  },
}));

const DARK_BACKGROUND = "#282828";
const LIGHT_BACKGROUND = "#fbf1c7";

let dir: string;
let state: string;
let running: Promise<void> | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marbles-settings-production-"));
  state = join(dir, "state");
  await mkdir(state);
  captured.updates.length = 0;
  captured.settings = undefined;
  captured.controller = undefined;
});

afterEach(async () => {
  captured.controller?.abort();
  await running;
  running = undefined;
  applyTheme("dark");
  await chmod(state, 0o700).catch(() => undefined);
  await rm(dir, { force: true, recursive: true });
});

/** Open the dashboard over `state` and wait for its settings action. */
async function open() {
  const args = parseArgs([
    "--state",
    state,
    "--config",
    join(dir, "workspace", ".foundry", "marbles"),
  ]);
  running = runInteractive(args);
  await vi.waitFor(() => {
    expect(captured.updates.length).toBeGreaterThan(0);
  });
  return captured.settings;
}

/** Call the action as the dashboard does; it must not throw out of the key handler. */
function change(
  settings: ((changes: SettingsChange) => Promise<void>) | undefined,
  changes: SettingsChange
): Promise<void> {
  if (!settings) {
    throw new Error("the dashboard connected no settings action");
  }
  let result: Promise<void> | undefined;
  expect(() => {
    result = settings(changes);
  }).not.toThrow();
  if (!result) {
    throw new Error("the settings action returned nothing");
  }
  return result;
}

function shown(): DashboardSnapshot | undefined {
  return captured.updates.at(-1);
}

it("rejects a save over a malformed settings file, changes nothing, and saves once it is repaired", async () => {
  const path = join(state, "settings.json");
  await writeFile(path, "{not json");
  const settings = await open();
  expect(shown()?.settings?.problem).toContain("is not valid JSON");

  await expect(change(settings, { theme: "light" })).rejects.toThrow(
    "fix or remove it to save settings"
  );
  expect(await readFile(path, "utf8")).toBe("{not json");
  expect(theme.colors.background).toBe(DARK_BACKGROUND);

  await writeFile(path, JSON.stringify({ future: 1 }));
  await change(settings, { theme: "light" });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    future: 1,
    theme: "light",
  });
  expect(theme.colors.background).toBe(LIGHT_BACKGROUND);
  const after = shown();
  expect(after?.settings).toEqual({ path, theme: "light" });
  expect(after?.diagnostics?.map((entry) => entry.message)).toContain(
    "[settings] theme light"
  );
});

it("rejects a save the state root cannot hold, and a later save works", async () => {
  // Root writes through a read-only directory.
  if (process.getuid?.() === 0) {
    return;
  }
  const path = join(state, "settings.json");
  const settings = await open();
  await chmod(state, 0o500);
  await expect(change(settings, { theme: "light" })).rejects.toThrow();
  expect(theme.colors.background).toBe(DARK_BACKGROUND);

  await chmod(state, 0o700);
  await change(settings, { theme: "light" });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "light" });
  expect(shown()?.settings?.theme).toBe("light");
});
