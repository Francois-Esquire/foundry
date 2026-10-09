import { homedir } from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { registerRpcTransport } from "./api/transport";
import { ModuleBuilds } from "./modules/builds/controller";
import { createBuildRuntime } from "./modules/builds/runtime";
import { openLocalModuleLibrary } from "./modules/local-library";
import { ModuleSessions } from "./modules/runtime/controller";
import {
  registerModuleProtocol,
  registerModuleScheme,
} from "./modules/runtime/protocol";
import { createModuleRuntime } from "./modules/runtime/runtime";
import { openAppVault } from "./vault/safe-storage";
import { createMainWindow } from "./window";
import { registerWindowIpc } from "./window-ipc";

registerModuleScheme();

app
  .whenReady()
  .then(async () => {
    const vault = await openAppVault(app.getPath("userData"));
    const userData = app.getPath("userData");
    const moduleRoot = path.join(homedir(), ".foundry", "modules");
    const { library: modules, store } = await openLocalModuleLibrary(
      moduleRoot,
      userData
    );
    const builds = new ModuleBuilds(
      modules,
      await createBuildRuntime(moduleRoot)
    );
    const sessions = new ModuleSessions(
      modules,
      await createModuleRuntime(moduleRoot, store)
    );
    registerModuleProtocol(sessions);
    // Cleanup starts once and the app always quits after it settles, even
    // when a shutdown fails. Repeat quit requests wait for the same cleanup.
    let quitState: "running" | "cleaning" | "ready" = "running";
    app.on("before-quit", async (event) => {
      if (quitState === "ready") {
        return;
      }
      event.preventDefault();
      if (quitState === "cleaning") {
        return;
      }
      quitState = "cleaning";
      try {
        const results = await Promise.allSettled([
          builds.shutdown(),
          sessions.shutdown(),
        ]);
        for (const result of results) {
          if (result.status === "rejected") {
            process.stderr.write(
              `Module runtime cleanup failed: ${String(result.reason)}\n`
            );
          }
        }
      } finally {
        quitState = "ready";
        app.quit();
      }
    });
    await modules.list();
    registerRpcTransport({ builds, modules, sessions, vault });
    registerWindowIpc();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  })
  .catch((error: unknown) => {
    process.stderr.write(`Foundry Works failed to start: ${String(error)}\n`);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
