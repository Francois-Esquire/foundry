import { homedir } from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { ModuleBuilds } from "./modules/builds/controller";
import { createBuildRuntime } from "./modules/builds/runtime";
import { openLocalModuleLibrary } from "./modules/local-library";
import { ModuleSessions } from "./modules/runtime/controller";
import {
  registerModuleProtocol,
  registerModuleScheme,
} from "./modules/runtime/protocol";
import { createModuleRuntime } from "./modules/runtime/runtime";
import { registerRpcTransport } from "./router/transport";
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
    let quitting = false;
    app.on("before-quit", async (event) => {
      if (quitting) {
        return;
      }
      event.preventDefault();
      async function finishQuit() {
        try {
          await builds.shutdown();
          await sessions.shutdown();
          quitting = true;
          app.quit();
        } catch (error) {
          process.stderr.write(
            `Module runtime cleanup failed: ${String(error)}\n`
          );
        }
      }
      await finishQuit();
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
