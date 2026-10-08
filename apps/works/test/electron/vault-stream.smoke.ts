import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "electron";
import { registerRpcTransport } from "~/main/api/transport";
import { openModuleLibrary } from "~/main/modules/library";
import { openAppVault } from "~/main/vault/safe-storage";
import { createMainWindow } from "~/main/window";
import { registerWindowIpc } from "~/main/window-ipc";
import { captureThemes, waitFor } from "../helpers/electron";

// Keep main alive after the last window closes so cleanup can be asserted.
app.on("window-all-closed", () => undefined);

/** Real renderer/preload/main transport, isolated from the user's vault. */
async function smoke(): Promise<void> {
  const [userData] = process.argv.slice(2);
  assert.ok(userData, "An isolated profile path is required");
  app.setPath("userData", userData);
  await app.whenReady();
  const vault = await openAppVault(userData);
  const subscribe = vault.onChange.bind(vault);
  let subscriptions = 0;
  let cancellations = 0;
  vault.onChange = (listener) => {
    subscriptions += 1;
    const unsubscribe = subscribe(listener);
    let closed = false;
    return () => {
      if (!closed) {
        closed = true;
        subscriptions -= 1;
        cancellations += 1;
        unsubscribe();
      }
    };
  };

  registerRpcTransport({ modules: openModuleLibrary(userData), vault });
  registerWindowIpc();
  const window = createMainWindow();
  try {
    await once(window.webContents, "did-finish-load", {
      signal: AbortSignal.timeout(10_000),
    });
    const navigate = async (route: string) => {
      await window.webContents.executeJavaScript(
        `location.hash = ${JSON.stringify(route)}`
      );
    };
    const hasBadge = async (label: string): Promise<boolean> =>
      (await window.webContents.executeJavaScript(
        `[...document.querySelectorAll('section[aria-labelledby="settings-providers"] span')]
            .some(element => element.textContent.trim() === ${JSON.stringify(label)})`
      )) === true;

    await navigate("#/settings");
    await waitFor(() => hasBadge("Default fallback"), "No initial status");
    assert.equal(subscriptions, 1, "Settings must share one watch");
    await captureThemes(window, "settings");

    await vault.set("gateway", "baseURL", "http://stream.test");
    await waitFor(() => hasBadge("Custom"), "Main-process save was not pushed");
    await vault.set("gateway", "baseURL", null);
    await waitFor(() => hasBadge("Default fallback"), "Clear was not pushed");

    await navigate("#/");
    await waitFor(() => subscriptions === 0, "Navigation leaked a watch");
    await vault.set("gateway", "baseURL", "http://reconnect.test");
    await navigate("#/settings");
    await waitFor(() => hasBadge("Custom"), "Remount did not get fresh status");
    assert.equal(subscriptions, 1);

    const beforeReload = cancellations;
    const loaded = once(window.webContents, "did-finish-load", {
      signal: AbortSignal.timeout(10_000),
    });
    window.webContents.reload();
    await loaded;
    await waitFor(
      () => subscriptions === 1 && cancellations > beforeReload,
      "Reload did not release the old watch and establish one replacement"
    );
    await waitFor(() => hasBadge("Custom"), "Reload did not get fresh status");

    window.close();
    await waitFor(() => subscriptions === 0, "Window close leaked a watch");
    process.stdout.write(
      "Electron vault stream passed: pushes, navigation, reload, and close\n"
    );
  } catch (error) {
    const renderer = await window.webContents.executeJavaScript(
      "JSON.stringify({ url: location.href, text: document.body.innerText, bridge: !!window.worksWindow })"
    );
    process.stderr.write(
      `Electron smoke diagnostics: ${JSON.stringify({ error: String(error), renderer, status: vault.status(), subscriptions })}\n`
    );
    throw error;
  } finally {
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
}

// Electron waits for main-module evaluation before emitting ready. Do not
// await smoke at the top level while it waits for that event.
smoke()
  .then(() => app.quit())
  .catch((error: unknown) => {
    process.stderr.write(`Electron vault stream failed: ${String(error)}\n`);
    app.exit(1);
  });
