import { describe, expect, it, vi } from "vitest";
import {
  createWindowBridge,
  WINDOW_CHANNELS,
  type WindowInvoke,
} from "~/shared/window-bridge";

describe("createWindowBridge", () => {
  it("routes each operation to its channel", async () => {
    const invoke = vi.fn<WindowInvoke>(async () => undefined);
    const bridge = createWindowBridge(invoke);

    await bridge.minimize();
    await bridge.close();
    await bridge.setFullscreen(true);

    expect(invoke.mock.calls).toEqual([
      [WINDOW_CHANNELS.minimize],
      [WINDOW_CHANNELS.close],
      [WINDOW_CHANNELS.setFullscreen, { fullscreen: true }],
    ]);
  });

  it("returns the reported mode and falls back to normal", async () => {
    const reported = createWindowBridge(async () => "fullscreen");
    const garbage = createWindowBridge(async () => "sideways");

    expect(await reported.mode()).toBe("fullscreen");
    expect(await garbage.mode()).toBe("normal");
  });
});
