import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error(message);
}

export async function captureThemes(
  window: BrowserWindow,
  name: string
): Promise<void> {
  const directory = path.resolve(
    import.meta.dirname,
    "../../.cache/electron/screenshots"
  );
  await mkdir(directory, { recursive: true });
  window.webContents.debugger.attach("1.3");
  try {
    for (const theme of ["light", "dark"]) {
      await window.webContents.debugger.sendCommand(
        "Emulation.setEmulatedMedia",
        {
          features: [{ name: "prefers-color-scheme", value: theme }],
        }
      );
      await window.webContents.executeJavaScript(`
        document.fonts.ready.then(() => new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))))
          .then(() => Promise.all(document.getAnimations().map(animation =>
            animation.finished.catch(() => undefined))));
      `);
      await waitFor(
        () =>
          window.webContents.executeJavaScript(
            `document.documentElement.classList.contains('${theme}')`
          ),
        "Theme did not update"
      );
      // Guest views render in another process; let its compositor finish the theme frame.
      await delay(100);
      const screenshot = await window.webContents.capturePage();
      await writeFile(
        path.join(directory, `${name}-${theme}.png`),
        screenshot.toPNG()
      );
    }
  } finally {
    window.webContents.debugger.detach();
  }
}

/**
 * Runs one Electron smoke. Its first argument is the isolated user data
 * directory, set before the app is ready; `smoke` runs once it is, with that
 * directory and the remaining arguments. Main stays alive after the last
 * window closes so cleanup can be asserted. Success quits; a failure is
 * reported, closes any window left open and exits 1.
 */
export function runElectronSmoke(
  name: string,
  smoke: (userData: string, args: readonly string[]) => Promise<void>
): void {
  const [userData, ...args] = process.argv.slice(2);
  if (!userData) {
    throw new Error(`Electron ${name} needs an isolated user data directory`);
  }
  app.setPath("userData", userData);
  app.on("window-all-closed", () => undefined);
  // Electron emits ready only after main's module evaluation finishes, so
  // the smoke must not be awaited at the top level.
  app
    .whenReady()
    .then(() => smoke(userData, args))
    .then(
      () => app.quit(),
      (error: unknown) => {
        process.stderr.write(`Electron ${name} failed: ${String(error)}\n`);
        for (const window of BrowserWindow.getAllWindows()) {
          window.destroy();
        }
        app.exit(1);
      }
    );
}
