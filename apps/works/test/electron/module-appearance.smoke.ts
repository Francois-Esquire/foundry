import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserWindow } from "electron";
import {
  registerModuleProtocol,
  registerModuleScheme,
} from "~/main/modules/runtime/protocol";
import { THEME_CAPABILITY } from "~/main/modules/theme-capability";
import { systemTheme } from "~/main/system/theme";
import { runElectronSmoke, waitFor } from "../helpers/electron";
import { themeReleasePackage } from "../helpers/module-release";
import { smokeWorks } from "../helpers/smoke-works";

registerModuleScheme();

const run = promisify(execFile);
const APPEARANCE_CHANGE_MS = 30_000;

/** The desktop's dark mode, through System Events (needs Automation access). */
async function darkMode(): Promise<boolean> {
  const { stdout } = await run("osascript", [
    "-e",
    'tell application "System Events" to tell appearance preferences to get dark mode',
  ]);
  return stdout.trim() === "true";
}

async function setDarkMode(dark: boolean): Promise<void> {
  await run("osascript", [
    "-e",
    `tell application "System Events" to tell appearance preferences to set dark mode to ${dark}`,
  ]);
}

/**
 * A real macOS appearance change, with main in `auto` and a theme-approved
 * Module View open: Works' effective appearance and the View's theme follow
 * the desktop. It changes the user's desktop setting, so it is opt-in
 * (`test:appearance`) and always puts the original appearance back. Without
 * Automation access to System Events it stops before changing anything.
 */
async function smoke(userData: string) {
  let original: boolean;
  try {
    original = await darkMode();
  } catch (error) {
    throw new Error(
      `macOS refused to report the appearance (grant this terminal Automation access to System Events); nothing was changed: ${String(error)}`,
      { cause: error }
    );
  }
  const works = await smokeWorks(userData);
  const { access, sessions } = works.rpc;
  const imported = await works.rpc.modules.importPackage(
    (await themeReleasePackage()).encoded
  );
  const contentId = (await works.rpc.modules.details(imported.id))?.releases[0]
    ?.contentId;
  assert.ok(contentId, "Imported release missing");
  registerModuleProtocol(sessions);
  await access.approve(imported.id, THEME_CAPABILITY);
  const watch = sessions.watch(imported.id, contentId);
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const viewShows = (effective: string) =>
    waitFor(
      async () =>
        (await window.webContents.executeJavaScript(
          "document.body?.dataset.mode + '/' + document.body?.dataset.effective"
        )) === `auto/${effective}` &&
        systemTheme.snapshot()?.effective === effective,
      `Works and the View did not show auto/${effective}`,
      APPEARANCE_CHANGE_MS
    );
  try {
    const { value } = await watch.next();
    assert.ok(value, "The app did not start");
    await window.loadURL(`${value.origin}/`);
    await systemTheme.set("auto");
    const before = original ? "dark" : "light";
    const after = original ? "light" : "dark";
    await viewShows(before);
    await setDarkMode(!original);
    await viewShows(after);
    await setDarkMode(original);
    await viewShows(before);
    process.stdout.write(
      `Electron appearance passed: auto/${before} → auto/${after} → auto/${before} in Works and the View\n`
    );
  } finally {
    await setDarkMode(original).catch((error: unknown) => {
      process.stderr.write(
        `Restore the desktop appearance by hand (dark mode ${original}): ${String(error)}\n`
      );
    });
    window.destroy();
    await watch.return();
    await works.close();
  }
}

runElectronSmoke("module appearance", smoke);
