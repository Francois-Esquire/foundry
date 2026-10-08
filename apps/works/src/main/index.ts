import path from "node:path";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import { app, BrowserWindow } from "electron";
import { createModuleLibrary } from "./modules/library";
import { ModulePreviews } from "./modules/preview/controller";
import {
  registerPreviewProtocol,
  registerPreviewScheme,
} from "./modules/preview/protocol";
import { createPreviewRuntime } from "./modules/preview/runtime";
import { registerRpcTransport } from "./router/transport";
import { openAppVault } from "./vault/safe-storage";
import { createMainWindow } from "./window";
import { registerWindowIpc } from "./window-ipc";

registerPreviewScheme();

app
  .whenReady()
  .then(async () => {
    const vault = await openAppVault(app.getPath("userData"));
    const userData = app.getPath("userData");
    const store = new JsonArtifactStore({
      path: path.join(userData, "modules", "artifacts.json"),
    });
    const modules = createModuleLibrary(store);
    const previews = new ModulePreviews(
      modules,
      await createPreviewRuntime(userData, store)
    );
    registerPreviewProtocol(previews);
    let quitting = false;
    app.on("before-quit", async (event) => {
      if (quitting) {
        return;
      }
      event.preventDefault();
      async function finishQuit() {
        try {
          await previews.shutdown();
          quitting = true;
          app.quit();
        } catch (error) {
          process.stderr.write(
            `Module preview cleanup failed: ${String(error)}\n`
          );
        }
      }
      await finishQuit();
    });
    await modules.list();
    registerRpcTransport({ modules, previews, vault });
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
