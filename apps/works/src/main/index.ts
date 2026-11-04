import { homedir } from "node:os";
import path from "node:path";
import {
  gatewayBinding,
  ModelManager,
  vercelBinding,
} from "@foundry.sh/marbles/engine";
import { app, BrowserWindow, dialog } from "electron";
import { registerRpcTransport } from "./api/transport";
import { vaultAuthoringModels } from "./modules/authoring/models";
import {
  registerModuleProtocol,
  registerModuleScheme,
} from "./modules/runtime/protocol";
import { registerQuitCleanup } from "./quit";
import { electronNativeTheme } from "./system/native-theme";
import { systemTheme } from "./system/theme";
import { openAppVault } from "./vault/safe-storage";
import { createMainWindow, themeBackground } from "./window";
import { registerWindowIpc } from "./window-ipc";
import { composeWorks } from "./works";

registerModuleScheme();

app
  .whenReady()
  .then(async () => {
    const userData = app.getPath("userData");
    const print = (line: string) => process.stderr.write(`${line}\n`);
    // Main owns the theme: its stored preference applies before any window
    // or Module Program exists, and window backgrounds follow it.
    await systemTheme.open({
      file: path.join(userData, "theme.json"),
      native: electronNativeTheme,
    });
    systemTheme.subscribe(({ effective }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.setBackgroundColor(themeBackground(effective));
      }
    });
    // Chat turns and Module workflows route to these providers; credentials
    // are read from the vault when the work runs and never leave the host.
    const models = new ModelManager({
      bindings: [gatewayBinding, vercelBinding],
    });
    const vault = await openAppVault(userData);
    // Works' state is its own, apart from product storage under ~/.foundry.
    const works = await composeWorks({
      artifactRoot: path.join(homedir(), ".foundry", "artifacts"),
      models,
      moduleRoot: path.join(homedir(), ".foundry", "modules"),
      print,
      routes: vaultAuthoringModels(models, vault),
      theme: systemTheme,
      userData,
    });
    registerModuleProtocol(works.rpc.sessions);
    registerQuitCleanup(app, works.stages, (reason) => {
      print(`Works cleanup failed: ${String(reason)}`);
    });
    registerRpcTransport({ ...works.rpc, vault });
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
    dialog.showErrorBox(
      "Foundry Works could not start",
      error instanceof Error ? error.message : String(error)
    );
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
