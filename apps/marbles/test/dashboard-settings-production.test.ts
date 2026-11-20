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
import { parseArgs } from "~/cli/args";
import { runInteractive } from "~/cli/interactive";
import { applyTheme } from "~/cli/theme";
import { theme } from "~/components/ui/theme";
import type {
  RollResult,
  WorkspaceConnection,
  WorkspaceSummary,
} from "~/model/connection";
import type { DashboardSnapshot } from "~/model/dashboard";
import type { SettingsChange } from "~/model/settings";
import type * as Client from "~/process/client";
import { SPAWN_RECORD_ENV } from "~/process/spawned";
import { testHome } from "./helpers/home";

interface Captured {
  controller?: AbortController;
  providerReviews?: boolean[];
  rollResult?: RollResult;
  rollSchedule?: (key: string) => Promise<void>;
  settings?: (changes: SettingsChange) => Promise<void>;
  readonly updates: DashboardSnapshot[];
}

const captured = vi.hoisted((): Captured => ({ updates: [] }));

vi.mock("~/cli/app", () => ({
  openDashboard: (_name: string, controller: AbortController) => {
    captured.controller = controller;
    return Promise.resolve({
      close: () => undefined,
      connect: (host: {
        settings?: (changes: SettingsChange) => Promise<void>;
        rollSchedule?: (key: string) => Promise<void>;
      }) => {
        captured.settings = host.settings;
        captured.rollSchedule = host.rollSchedule;
      },
      entry: Promise.resolve(true),
      failure: () => Promise.resolve(),
      onboard: () => Promise.resolve(true),
      reviewProviders: async (
        _root: string,
        review: { offered: readonly unknown[] },
        proceed: (accept: boolean) => Promise<void>
      ) => {
        captured.providerReviews?.push(review.offered.length > 0);
        await proceed(false);
        return true;
      },
      update: (snapshot: DashboardSnapshot) => {
        captured.updates.push(snapshot);
      },
    });
  },
}));

vi.mock("~/workspace/host", () => ({ hostWorkspace: vi.fn() }));

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
          roll: () => Promise.resolve(captured.rollResult ?? { lines: [] }),
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

async function useHome(providers: boolean) {
  dir = await mkdtemp(join(tmpdir(), "marbles-settings-production-"));
  const home = testHome({ providers });
  vi.stubEnv("FOUNDRY_HOME", home.path);
  vi.stubEnv(SPAWN_RECORD_ENV, home.env[SPAWN_RECORD_ENV]);
  ({ state } = home.layout);
  captured.updates.length = 0;
  captured.settings = undefined;
  captured.controller = undefined;
  captured.providerReviews = [];
  captured.rollSchedule = undefined;
  captured.rollResult = undefined;
  await mkdir(state, { recursive: true });
}

beforeEach(() => useHome(true));

afterEach(async () => {
  vi.unstubAllEnvs();
  captured.controller?.abort();
  await running;
  running = undefined;
  applyTheme("dark");
  await chmod(state, 0o700).catch(() => undefined);
  await rm(dir, { force: true, recursive: true });
});

async function open() {
  const args = parseArgs([
    "--config",
    join(dir, "workspace", ".foundry", "marbles"),
  ]);
  running = runInteractive(args);
  await vi.waitFor(() => {
    expect(captured.updates.length).toBeGreaterThan(0);
  });
  return captured.settings;
}

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

it("continues past provider review without overwriting unreadable settings", async () => {
  await rm(dir, { force: true, recursive: true });
  await useHome(false);
  vi.stubEnv("PATH", "/usr/bin:/bin");
  const path = join(state, "settings.json");
  await writeFile(path, "{not json");

  await open();

  expect(captured.providerReviews).toEqual([false]);
  expect(await readFile(path, "utf8")).toBe("{not json");
  expect(shown()?.settings?.problem).toContain("is not valid JSON");
  expect(shown()?.diagnostics?.map((entry) => entry.message)).toContainEqual(
    expect.stringContaining("could not record provider setup")
  );
});

it("reports a held schedule and accepts a dispatched run with no output", async () => {
  await open();
  const roll = captured.rollSchedule;
  if (!roll) {
    throw new Error("the dashboard connected no schedule action");
  }

  captured.rollResult = {
    lines: ["another log format"],
    skipped: "held by this process",
  };
  await expect(roll("daily")).rejects.toThrow(
    "daily skipped: held by this process"
  );

  captured.rollResult = { lines: ["[schedule] daily → summarize-day"] };
  await expect(roll("daily")).resolves.toBeUndefined();
});
