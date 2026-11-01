import { BrowserWindow } from "electron";
import type { ModuleSessions } from "~/main/modules/runtime/controller";
import { waitFor } from "./electron";

/**
 * A released app opened as the Electron entry would, in a hidden sandboxed
 * window over `module-app:`. `graphql` posts to the Program's GraphQL route
 * from the View; `close` closes the window and stops the Program.
 */
export async function openAppWindow(
  sessions: ModuleSessions,
  moduleId: string,
  contentId: string
) {
  const watch = sessions.watch(moduleId, contentId);
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  async function close() {
    if (!window.isDestroyed()) {
      window.destroy();
    }
    await watch.return();
    await sessions.stop(moduleId);
  }
  try {
    const { value } = await watch.next();
    if (!value) {
      throw new Error("The app did not start");
    }
    await window.loadURL(`${value.origin}/`);
    await waitFor(
      async () =>
        (await window.webContents.executeJavaScript(
          "!!document.querySelector('h1')"
        )) === true,
      "The app's View did not render",
      60_000
    );
  } catch (error) {
    await close();
    throw error;
  }
  return {
    close,
    graphql: (query: string): Promise<unknown> =>
      window.webContents.executeJavaScript(`(async () => {
        const response = await fetch('/_module/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: ${JSON.stringify(query)} }) });
        return await response.json();
      })()`),
    heading: (): Promise<string> =>
      window.webContents.executeJavaScript(
        "document.querySelector('h1')?.textContent ?? ''"
      ),
  };
}
