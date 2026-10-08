export type WindowMode = "fullscreen" | "maximized" | "minimized" | "normal";

export const WINDOW_CHANNELS = {
  close: "works:window:close",
  minimize: "works:window:minimize",
  mode: "works:window:mode",
  setFullscreen: "works:window:set-fullscreen",
} as const;

type WindowChannel = (typeof WINDOW_CHANNELS)[keyof typeof WINDOW_CHANNELS];

/** What the preload exposes to the renderer as `window.worksWindow`. */
export interface WorksWindowBridge {
  close(): Promise<void>;
  minimize(): Promise<void>;
  mode(): Promise<WindowMode>;
  setFullscreen(fullscreen: boolean): Promise<void>;
}

export type WindowInvoke = (
  channel: WindowChannel,
  ...args: unknown[]
) => Promise<unknown>;

const WINDOW_MODES: readonly WindowMode[] = [
  "fullscreen",
  "maximized",
  "minimized",
  "normal",
];

function isWindowMode(value: unknown): value is WindowMode {
  return WINDOW_MODES.some((mode) => mode === value);
}

export function createWindowBridge(invoke: WindowInvoke): WorksWindowBridge {
  return {
    async close() {
      await invoke(WINDOW_CHANNELS.close);
    },
    async minimize() {
      await invoke(WINDOW_CHANNELS.minimize);
    },
    async mode() {
      const mode = await invoke(WINDOW_CHANNELS.mode);
      return isWindowMode(mode) ? mode : "normal";
    },
    async setFullscreen(fullscreen) {
      await invoke(WINDOW_CHANNELS.setFullscreen, { fullscreen });
    },
  };
}
