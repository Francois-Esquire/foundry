import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import { WINDOW_CHANNELS, type WindowMode } from "~/shared/window-bridge";
import { windowMode } from "./window";

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window === null || window.isDestroyed() ? null : window;
}

function isFullscreenRequest(value: unknown): value is { fullscreen: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "fullscreen" in value &&
    typeof value.fullscreen === "boolean"
  );
}

/** Window chrome operations the renderer's custom title bar invokes. */
export function registerWindowIpc(): void {
  ipcMain.handle(WINDOW_CHANNELS.minimize, (event) => {
    senderWindow(event)?.minimize();
  });
  ipcMain.handle(WINDOW_CHANNELS.close, (event) => {
    senderWindow(event)?.close();
  });
  ipcMain.handle(WINDOW_CHANNELS.setFullscreen, (event, request: unknown) => {
    if (!isFullscreenRequest(request)) {
      throw new Error("set-fullscreen expects { fullscreen: boolean }");
    }
    senderWindow(event)?.setFullScreen(request.fullscreen);
  });
  ipcMain.handle(WINDOW_CHANNELS.mode, (event): WindowMode => {
    const window = senderWindow(event);
    return window === null ? "normal" : windowMode(window);
  });
}
