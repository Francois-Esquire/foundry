import path from "node:path";
import { BrowserWindow, dialog, nativeTheme, screen, shell } from "electron";
import type { ThemeAppearance } from "~/shared/theme";
import type { WindowMode } from "~/shared/window-bridge";
import { systemTheme } from "./system/theme";

const SHELL_SCALE = 0.75;

/** Matched to the pre-paint colours in index.html. */
export function themeBackground(appearance: ThemeAppearance): string {
  return appearance === "dark" ? "#0a0a0a" : "#ffffff";
}

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
    // Main's theme, matched to the pre-paint colour in index.html, so the
    // first frame the compositor shows is the colour that replaces it.
    backgroundColor: themeBackground(
      systemTheme.snapshot()?.effective ??
        (nativeTheme.shouldUseDarkColors ? "dark" : "light")
    ),
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

  // Never spawn child windows; real links open in the OS browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: "deny" };
  });

  // The renderer blocks unloading while a Module has unsaved edits; ask
  // before closing anyway. The Draft itself stays on this device.
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      buttons: ["Keep editing", "Close anyway"],
      cancelId: 0,
      defaultId: 0,
      detail:
        "Your draft stays on this device, but it is not saved to the Module.",
      message: "This Module has unsaved changes.",
      type: "warning",
    });
    if (choice === 1) {
      event.preventDefault();
    }
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

/**
 * Electron reports four independent predicates; a window has one mode.
 * Fullscreen wins because it is what the user sees, and minimized beats
 * maximized for the same reason.
 */
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
