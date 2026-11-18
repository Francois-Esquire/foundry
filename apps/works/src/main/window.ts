import path from "node:path";
import { BrowserWindow, nativeTheme, screen, shell } from "electron";
import type { WindowMode } from "~/shared/window-bridge";

const SHELL_SCALE = 0.75;

function shellSize(): { height: number; width: number } {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    height: Math.round(height * SHELL_SCALE),
    width: Math.round(width * SHELL_SCALE),
  };
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...shellSize(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
    center: true,
    frame: false,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: "deny" };
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    window.loadURL(devServerUrl).catch(() => undefined);
  } else {
    window
      .loadFile(path.join(import.meta.dirname, "../renderer/index.html"))
      .catch(() => undefined);
  }

  return window;
}

export function windowMode(window: BrowserWindow): WindowMode {
  if (window.isFullScreen()) {
    return "fullscreen";
  }
  if (window.isMinimized()) {
    return "minimized";
  }
  if (window.isMaximized()) {
    return "maximized";
  }
  return "normal";
}
