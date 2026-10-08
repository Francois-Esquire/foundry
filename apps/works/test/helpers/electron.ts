import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserWindow } from "electron";

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string
): Promise<void> {
  const deadline = Date.now() + 10_000;
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
  for (const theme of ["light", "dark"]) {
    await window.webContents.executeJavaScript(`
      document.documentElement.classList.remove('light', 'dark', 'auto');
      document.documentElement.classList.add('${theme}');
      document.fonts.ready.then(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))))
        .then(() => Promise.all(document.getAnimations().map(animation =>
          animation.finished.catch(() => undefined))));
    `);
    const screenshot = await window.webContents.capturePage();
    await writeFile(
      path.join(directory, `${name}-${theme}.png`),
      screenshot.toPNG()
    );
  }
}
