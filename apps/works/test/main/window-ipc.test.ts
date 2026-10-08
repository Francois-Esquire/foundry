import { beforeEach, describe, expect, it, vi } from "vitest";
import { WINDOW_CHANNELS } from "~/shared/window-bridge";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const handlers = new Map<string, Handler>();
const fakeWindow = {
  close: vi.fn(),
  isDestroyed: vi.fn(() => false),
  isFullScreen: vi.fn(() => false),
  isMaximized: vi.fn(() => true),
  isMinimized: vi.fn(() => false),
  minimize: vi.fn(),
  setFullScreen: vi.fn(),
};

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => fakeWindow) },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  },
}));

const { registerWindowIpc } = await import("~/main/window-ipc");

describe("registerWindowIpc", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerWindowIpc();
  });

  it("registers every window channel", () => {
    expect([...handlers.keys()].sort()).toEqual(
      Object.values(WINDOW_CHANNELS).sort()
    );
  });

  it("drives the sender's window", async () => {
    const event = { sender: {} };
    await handlers.get(WINDOW_CHANNELS.minimize)?.(event);
    await handlers.get(WINDOW_CHANNELS.setFullscreen)?.(event, {
      fullscreen: true,
    });
    const mode = await handlers.get(WINDOW_CHANNELS.mode)?.(event);

    expect(fakeWindow.minimize).toHaveBeenCalledTimes(1);
    expect(fakeWindow.setFullScreen).toHaveBeenCalledWith(true);
    expect(mode).toBe("maximized");
  });

  it("rejects a malformed fullscreen request", () => {
    expect(() =>
      handlers.get(WINDOW_CHANNELS.setFullscreen)?.({ sender: {} }, "yes")
    ).toThrow("set-fullscreen expects");
  });

  it("ignores a destroyed window", async () => {
    fakeWindow.isDestroyed.mockReturnValueOnce(true);
    await handlers.get(WINDOW_CHANNELS.close)?.({ sender: {} });
    expect(fakeWindow.close).not.toHaveBeenCalled();
  });
});
