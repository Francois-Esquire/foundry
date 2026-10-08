import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserWindow } from "electron";

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
