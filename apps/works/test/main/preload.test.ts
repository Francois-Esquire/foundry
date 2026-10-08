import { expect, it, vi } from "vitest";
import { RPC_CHANNELS } from "~/shared/rpc";
import {
  WINDOW_CHANNELS,
  type WorksWindowBridge,
} from "~/shared/window-bridge";

const { exposeInMainWorld, invoke, postMessage, addEventListener } = vi.hoisted(
  () => ({
    addEventListener: vi.fn(),
    exposeInMainWorld: vi.fn(),
    invoke: vi.fn(() => Promise.resolve()),
    postMessage: vi.fn(),
  })
);

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, postMessage },
}));

// The preload runs in a window; the node project has none.
const fakeWindow = { addEventListener };
vi.stubGlobal("window", fakeWindow);

await import("~/preload");

function exposedBridge(): WorksWindowBridge {
  const [exposure] = exposeInMainWorld.mock.calls;
  if (!exposure) {
    throw new Error("preload did not expose a bridge");
  }
  return exposure[1] as WorksWindowBridge;
}

function messageListener(): (event: unknown) => void {
  const call = addEventListener.mock.calls.find(([type]) => type === "message");
  if (!call) {
    throw new Error("preload did not listen for window messages");
  }
  return call[1] as (event: unknown) => void;
}

it("exposes the bridge as window.worksWindow", () => {
  expect(exposeInMainWorld).toHaveBeenCalledOnce();
  expect(exposeInMainWorld.mock.calls[0]?.[0]).toBe("worksWindow");
});

it("invokes the shared channels", async () => {
  const bridge = exposedBridge();

  await bridge.minimize();
  await bridge.close();
  await bridge.setFullscreen(true);
  await bridge.mode();

  expect(invoke.mock.calls).toEqual([
    [WINDOW_CHANNELS.minimize],
    [WINDOW_CHANNELS.close],
    [WINDOW_CHANNELS.setFullscreen, { fullscreen: true }],
    [WINDOW_CHANNELS.mode],
  ]);
});

it("forwards the renderer's RPC port to main", () => {
  const port = { name: "port" };
  const listener = messageListener();

  listener({ data: "unrelated", ports: [port], source: fakeWindow });
  listener({
    data: RPC_CHANNELS.clientStart,
    ports: [port],
    source: fakeWindow,
  });

  expect(postMessage).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenCalledWith(RPC_CHANNELS.serverStart, null, [
    port,
  ]);
});
