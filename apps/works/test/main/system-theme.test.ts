import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { router } from "~/main/api";
import {
  describedCapabilities,
  worksCapabilityCatalog,
} from "~/main/modules/capabilities";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import {
  THEME_CAPABILITY,
  themeCapability,
} from "~/main/modules/theme-capability";
import { SystemTheme } from "~/main/system/theme";
import type { ThemeSnapshot } from "~/shared/theme";
import { startTestExecution } from "../helpers/execution";
import { openFakeVault } from "../helpers/fake-api";
import { installedProcess } from "../helpers/installed-programs";
import { fakeNativeTheme } from "../helpers/native-theme";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "works-theme-"));
  directories.push(created);
  return created;
}

async function openTheme(file: string, desktopDark = false) {
  const native = fakeNativeTheme(desktopDark);
  const theme = new SystemTheme();
  const snapshot = await theme.open({ file, native: native.native });
  return { native, snapshot, theme };
}

describe("main's theme", () => {
  it("starts in auto on the desktop's appearance and persists an explicit choice", async () => {
    const file = path.join(await temporaryDirectory(), "theme.json");
    const first = await openTheme(file, true);
    expect(first.snapshot).toEqual({
      effective: "dark",
      mode: "auto",
      revision: 1,
    });
    expect(first.native.source).toBe("system");

    await first.theme.set("light");
    expect(first.native.source).toBe("light");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      format: "works.theme/1",
      mode: "light",
    });

    // A later start reads the preference before anything is shown.
    const second = await openTheme(file, true);
    expect(second.snapshot).toMatchObject({
      effective: "light",
      mode: "light",
    });
    expect(second.native.source).toBe("light");
  });

  it("adopts the renderer's stored mode on first run only", async () => {
    const file = path.join(await temporaryDirectory(), "theme.json");
    const first = await openTheme(file);
    expect(await first.theme.adopt("dark")).toMatchObject({ mode: "dark" });
    expect(await first.theme.adopt("light")).toMatchObject({ mode: "dark" });

    const second = await openTheme(file);
    expect(await second.theme.adopt("light")).toMatchObject({ mode: "dark" });

    // No stored renderer mode: auto is stored, and later offers change nothing.
    const fresh = await openTheme(
      path.join(await temporaryDirectory(), "theme.json")
    );
    expect(await fresh.theme.adopt(null)).toMatchObject({ mode: "auto" });
    expect(await fresh.theme.adopt("dark")).toMatchObject({ mode: "auto" });
  });

  it("treats an unreadable preference as none", async () => {
    const file = path.join(await temporaryDirectory(), "theme.json");
    await writeFile(file, '{"format":"works.theme/1","mode":"sepia"}');
    const { theme } = await openTheme(file);
    expect(theme.snapshot()?.mode).toBe("auto");
    expect(await theme.adopt("dark")).toMatchObject({ mode: "dark" });
  });

  it("follows a desktop appearance change only in auto", async () => {
    const { native, theme } = await openTheme(
      path.join(await temporaryDirectory(), "theme.json")
    );
    const seen: ThemeSnapshot[] = [];
    theme.subscribe((snapshot) => seen.push(snapshot));

    native.desktop(true);
    expect(theme.snapshot()).toEqual({
      effective: "dark",
      mode: "auto",
      revision: 2,
    });
    await theme.set("light");
    native.desktop(false);
    native.desktop(true);
    expect(theme.snapshot()).toEqual({
      effective: "light",
      mode: "light",
      revision: 3,
    });
    await theme.set("auto");
    expect(seen.map((snapshot) => snapshot.revision)).toEqual([2, 3, 4]);
    expect(seen.at(-1)).toMatchObject({ effective: "dark", mode: "auto" });
  });

  it("serves the renderer a snapshot, then changes, over the router", async () => {
    const { theme } = await openTheme(
      path.join(await temporaryDirectory(), "theme.json")
    );
    const client = createRouterClient(router, {
      context: {
        modules: {} as never,
        theme,
        vault: await openFakeVault(),
      },
    });
    const controller = new AbortController();
    const snapshots = await client.theme.watch(undefined, {
      signal: controller.signal,
    });
    expect((await snapshots.next()).value).toMatchObject({ mode: "auto" });
    expect(theme.subscribers).toBe(1);
    expect(await client.theme.set({ mode: "dark" })).toMatchObject({
      mode: "dark",
    });
    expect((await snapshots.next()).value).toMatchObject({ mode: "dark" });
    await expect(
      client.theme.set({ mode: "sepia" as never })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await snapshots.return();
    expect(theme.subscribers).toBe(0);
  });
});

describe("works.system.theme", () => {
  it("is in Works' catalog as a read-only stream", () => {
    const catalog = worksCapabilityCatalog();
    expect(
      catalog.capabilities.filter(
        (descriptor) => descriptor.capability === THEME_CAPABILITY
      )
    ).toEqual([
      expect.objectContaining({
        capability: THEME_CAPABILITY,
        mode: "stream",
        version: 1,
      }),
    ]);
    expect(describedCapabilities()).toHaveLength(catalog.capabilities.length);
  });

  it("subscribes before the snapshot, skips repeats and collapses a backlog to the latest", async () => {
    const { native, theme } = await openTheme(
      path.join(await temporaryDirectory(), "theme.json")
    );
    const controller = new AbortController();
    const stream = theme.watch(controller.signal);
    const first = stream.next();
    expect(theme.subscribers).toBe(1);
    expect((await first).value).toEqual({
      effective: "light",
      mode: "auto",
      revision: 1,
    });

    // Three changes and a no-op while the consumer is busy: it gets the last.
    await theme.set("dark");
    await theme.set("light");
    native.desktop(true);
    await theme.set("dark");
    await theme.set("dark");
    expect((await stream.next()).value).toEqual({
      effective: "dark",
      mode: "dark",
      revision: 4,
    });

    const pending = stream.next();
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(theme.subscribers).toBe(0);
  });

  it("waits for main's preference and never sees a change it subscribed after", async () => {
    const theme = new SystemTheme();
    const controller = new AbortController();
    const stream = theme.watch(controller.signal);
    const first = stream.next();
    await theme.open({
      file: path.join(await temporaryDirectory(), "theme.json"),
      native: fakeNativeTheme().native,
    });
    expect((await first).value).toMatchObject({ mode: "auto", revision: 1 });
    controller.abort();
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  it("takes no constraints and an empty input", async () => {
    const theme = new SystemTheme();
    const { provider } = themeCapability(theme);
    if (!provider) {
      throw new Error("The theme is a Gateway capability");
    }
    const principal = {} as never;
    await expect(
      provider.resolveConstraints({ principal, releaseConstraints: null })
    ).resolves.toEqual({ constraintsDigest: "works.system.theme@1:read" });
    await expect(
      provider.resolveConstraints({
        principal,
        releaseConstraints: { mode: "dark" },
      })
    ).rejects.toThrow("takes no constraints");
    expect(() => provider.registration.input.parse({ mode: "dark" })).toThrow(
      "empty input"
    );
  });

  it("is delivered only under an approved Grant, cannot change the preference, and ends on revoke", async () => {
    const root = await temporaryDirectory();
    const { theme } = await openTheme(path.join(root, "theme.json"));
    const execution = await startTestExecution();
    const process = installedProcess(
      new JsonArtifactStore({ path: path.join(root, "artifacts.json") }),
      execution,
      root,
      [themeCapability(theme)]
    );
    const module = await process.library.create("Themed");
    const version = await process.release(module.id, "0.1.0", {
      capabilities: [
        {
          alias: "theme",
          capability: THEME_CAPABILITY,
          reason: "Matches the host appearance",
          version: 1,
        },
      ],
    });
    const app = await process.runtime.start(
      version,
      new AbortController().signal
    );
    const runtime = await process.programs.active(
      moduleInstallationId(module.id)
    );
    if (!runtime) {
      throw new Error("Program not active");
    }
    const observe = (id: string) =>
      process.invocations.dispatch({
        capabilities: version.manifest.capabilities,
        request: {
          alias: "theme",
          id,
          input: {},
          kind: "invoke",
          mode: "stream",
        },
        runtime,
        signal: new AbortController().signal,
      });

    // Not approved: no mode state at all.
    await expect(observe("request-1")).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(theme.subscribers).toBe(0);

    await process.access.approve(module.id, THEME_CAPABILITY);
    const result = await observe("request-2");
    if (result.mode !== "stream") {
      throw new Error("Theme is a stream");
    }
    const events = result.events[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ mode: "auto" });
    await theme.set("dark");
    expect((await events.next()).value).toMatchObject({ mode: "dark" });
    expect(theme.snapshot()?.mode).toBe("dark");

    const ended = expect(events.next()).rejects.toMatchObject({
      code: "cancelled",
    });
    await process.access.revoke(module.id, THEME_CAPABILITY);
    await ended;
    await vi.waitFor(() => expect(theme.subscribers).toBe(0));
    await expect(observe("request-3")).rejects.toMatchObject({
      code: "unauthorized",
    });
    await app.close();
  });
});
