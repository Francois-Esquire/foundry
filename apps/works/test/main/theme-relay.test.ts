import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import { createModuleGateway } from "@foundry/modules/gateway/module-gateway";
import { MODULE_SDK_EMITTED } from "@foundry/modules/sdk/emitted";
import { afterEach, expect, it, vi } from "vitest";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import { createModuleProxy } from "~/main/modules/runtime/proxy";
import { connectModuleSocket } from "~/main/modules/runtime/websocket";
import {
  THEME_CAPABILITY,
  themeCapability,
} from "~/main/modules/theme-capability";
import { SystemTheme } from "~/main/system/theme";
import type { ThemeSnapshot } from "~/shared/theme";
import { startTestExecution } from "../helpers/execution";
import { installedProcess } from "../helpers/installed-programs";
import { THEME_MANIFEST, THEME_PROGRAM_FILES } from "../helpers/module-release";
import { fakeNativeTheme } from "../helpers/native-theme";

interface BrowserSdk {
  watchModuleTheme(
    onTheme: (theme: ThemeSnapshot | null) => void,
    options?: { retryMs?: number; signal?: AbortSignal }
  ): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** The theme fixture Program, run by Bun on the host instead of in a VM. */
async function startProgram(directory: string): Promise<string> {
  const outputs = path.join(directory, "program");
  await mkdir(path.join(outputs, "outputs"), { recursive: true });
  for (const [file, text] of Object.entries(THEME_PROGRAM_FILES)) {
    await writeFile(path.join(outputs, file), text);
  }
  const child = spawn("bun", [path.join(outputs, "outputs/program.js")], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  cleanups.push(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  const lines = createInterface({ input: child.stdout });
  const [line] = (await once(lines, "line", {
    signal: AbortSignal.timeout(10_000),
  })) as [string];
  return `http://127.0.0.1:${line.replace("listening ", "")}`;
}

/** What a View sees: each report from the SDK's browser helper. */
function view(sdk: BrowserSdk) {
  const seen: (ThemeSnapshot | null)[] = [];
  let controller = new AbortController();
  const start = () => {
    controller.abort();
    controller = new AbortController();
    sdk
      .watchModuleTheme((theme) => seen.push(theme), {
        retryMs: 20,
        signal: controller.signal,
      })
      .catch(() => undefined);
  };
  start();
  return {
    latest: () => seen.at(-1),
    seen,
    start,
    stop: () => controller.abort(),
  };
}

it("relays the theme from main through the Gateway, a real Program and the proxy to a View", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "works-theme-relay-"));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const native = fakeNativeTheme();
  const theme = new SystemTheme();
  await theme.open({
    file: path.join(root, "theme.json"),
    native: native.native,
  });
  const execution = await startTestExecution();
  const host = installedProcess(
    new JsonArtifactStore({ path: path.join(root, "artifacts.json") }),
    execution,
    root,
    [themeCapability(theme)]
  );
  const module = await host.library.create("Themed");
  const version = await host.release(module.id, "0.1.0", {
    capabilities: THEME_MANIFEST.capabilities,
  });
  await host.access.approve(module.id, THEME_CAPABILITY);
  const app = await host.runtime.start(version, new AbortController().signal);
  const runtime = await host.programs.active(moduleInstallationId(module.id));
  if (!runtime) {
    throw new Error("Program not active");
  }

  // The host side of a released Program: the real Gateway over Works' socket.
  const origin = await startProgram(root);
  const session = await createModuleGateway({
    runtimeDispatcher: host.invocations,
    store: host.modules,
  }).connect({
    capabilities: version.manifest.capabilities,
    runtime,
    transport: await connectModuleSocket({
      url: new URL("/_foundry/module-gateway", origin.replace("http:", "ws:")),
    }),
  });
  cleanups.push(() => session.close("test complete"));

  // The View's same-origin fetches go through Works' proxy to that Program.
  const serving = new AbortController();
  const endpoint = {
    origin,
    signal: serving.signal,
    views: [{ id: "main", path: "/" }],
  };
  const proxy = createModuleProxy(
    { endpoint: () => endpoint },
    globalThis.fetch
  );
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    proxy(new Request(new URL(url, "module-app://token"), init))
  );
  const sdkFile = path.join(root, "sdk.mjs");
  await writeFile(sdkFile, MODULE_SDK_EMITTED.esm);
  const sdk = (await import(pathToFileURL(sdkFile).href)) as BrowserSdk;

  const page = view(sdk);
  await vi.waitFor(() =>
    expect(page.latest()).toEqual({
      effective: "light",
      mode: "auto",
      revision: 1,
    })
  );
  expect(theme.subscribers).toBe(1);

  // An explicit override and, in auto, a desktop change arrive live.
  await theme.set("dark");
  await vi.waitFor(() =>
    expect(page.latest()).toMatchObject({ effective: "dark", mode: "dark" })
  );
  await theme.set("auto");
  native.desktop(true);
  await vi.waitFor(() =>
    expect(page.latest()).toMatchObject({ effective: "dark", mode: "auto" })
  );

  // Disconnecting the View closes its Gateway stream; reconnecting refreshes.
  page.stop();
  await vi.waitFor(() => expect(theme.subscribers).toBe(0));
  page.start();
  await vi.waitFor(() => expect(theme.subscribers).toBe(1));
  expect(page.latest()).toMatchObject({ mode: "auto" });

  // Revoking ends the relay and clears mode state; retries stay unavailable.
  await host.access.revoke(module.id, THEME_CAPABILITY);
  await vi.waitFor(() => expect(page.latest()).toBeNull());
  expect(theme.subscribers).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(page.latest()).toBeNull();

  // Approving again lets the next retry take a fresh, authorized snapshot.
  await host.access.approve(module.id, THEME_CAPABILITY);
  await vi.waitFor(() => expect(page.latest()).toMatchObject({ mode: "auto" }));

  // The Program stops serving: the View's response ends with it.
  serving.abort();
  await vi.waitFor(() => expect(page.latest()).toBeNull());
  await vi.waitFor(() => expect(theme.subscribers).toBe(0));
  page.stop();
  await app.close();
}, 20_000);
