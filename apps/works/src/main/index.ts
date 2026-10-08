import { app, BrowserWindow } from "electron";
import { openModuleLibrary } from "./modules/library";
import { registerRpcTransport } from "./router/transport";
import { openAppVault } from "./vault/safe-storage";
import { createMainWindow } from "./window";
import { registerWindowIpc } from "./window-ipc";

app
  .whenReady()
  .then(async () => {
    const vault = await openAppVault(app.getPath("userData"));
    const modules = openModuleLibrary(app.getPath("userData"));
    await modules.list();
    registerRpcTransport({ modules, vault });
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
