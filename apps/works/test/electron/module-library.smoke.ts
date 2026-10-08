import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { registerRpcTransport } from "~/main/api/transport";
import { openModuleLibrary } from "~/main/modules/library";
import { openAppVault } from "~/main/vault/safe-storage";
import { createMainWindow } from "~/main/window";
import { registerWindowIpc } from "~/main/window-ipc";
import { captureThemes, waitFor } from "../helpers/electron";

import { openLibrary, sourceText } from "../helpers/module-source";

const MODULE_NAME = "Restart smoke module";
app.on("window-all-closed", () => undefined);

async function smoke(): Promise<void> {
  const [phase, userData] = process.argv.slice(2);
  assert.ok(userData, "An isolated profile path is required");
  assert.ok(phase === "create" || phase === "reopen", "Unknown smoke phase");
  app.setPath("userData", userData);
  await app.whenReady();
  const modules = openModuleLibrary(userData);
  const vault = await openAppVault(userData);
  registerRpcTransport({ modules, vault });
  registerWindowIpc();
  const window = createMainWindow();
  try {
    await once(window.webContents, "did-finish-load", {
      signal: AbortSignal.timeout(10_000),
    });
    await openLibrary(window);
    await waitFor(
      async () =>
        (await window.webContents.executeJavaScript(
          "!!document.querySelector('#module-name')"
        )) === true,
      "Module library did not render"
    );
    if (phase === "create") {
      await window.webContents.executeJavaScript(`
        const input = document.querySelector('#module-name');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          .set.call(input, ${JSON.stringify(MODULE_NAME)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      `);
      await waitFor(
        async () =>
          (await window.webContents.executeJavaScript(
            "!!document.querySelector('button[type=submit]:not(:disabled)')"
          )) === true,
        "Create module remained disabled"
      );
      await window.webContents.executeJavaScript(
        "document.querySelector('form').requestSubmit()"
      );
    } else {
      const saved = await readFile(
        path.join(userData, "expected-module-id"),
        "utf8"
      );
      const list = await modules.list();
      assert.equal(list.length, 1);
      assert.equal(list[0]?.id, saved, "Module identity changed after restart");
      assert.equal(list[0]?.name, MODULE_NAME);
      const selector = `a[href="#/modules/${saved}"]`;
      await waitFor(
        async () =>
          (await window.webContents.executeJavaScript(
            `!!document.querySelector(${JSON.stringify(selector)})`
          )) === true,
        "Persisted module did not appear in the restarted app"
      );
      await captureThemes(window, "modules");
      await window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}).click()`
      );
    }
    await waitFor(
      async () =>
        (await window.webContents.executeJavaScript(
          `document.querySelector('h1')?.textContent === ${JSON.stringify(MODULE_NAME)}
            && (${sourceText}).includes(${JSON.stringify(MODULE_NAME)})`
        )) === true,
      "Named module workspace did not show persisted authored source"
    );
    const list = await modules.list();
    assert.equal(list.length, 1);
    const [created] = list;
    assert.ok(created);
    if (phase === "create") {
      await writeFile(path.join(userData, "expected-module-id"), created.id);
    } else {
      await window.webContents.executeJavaScript("document.fonts.ready");
      for (const family of ["Public Sans", "IBM Plex Mono"]) {
        const loaded = await window.webContents.executeJavaScript(
          `Array.from(document.fonts).some(face =>
            face.family.includes(${JSON.stringify(family)}) && face.status === 'loaded')`
        );
        assert.equal(
          loaded,
          true,
          `${family} did not load from bundled assets`
        );
      }
      await captureThemes(window, "module-workspace");
    }
    window.close();
    process.stdout.write(`Electron module library passed: ${phase}\n`);
  } finally {
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
}

smoke()
  .then(() => app.quit())
  .catch((error: unknown) => {
    process.stderr.write(`Electron module library failed: ${String(error)}\n`);
    app.exit(1);
  });
