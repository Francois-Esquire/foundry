import type { MessagePortMain, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { acceptRpcPort } from "~/main/router/transport";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { on: vi.fn() },
}));

function fakePort(): MessagePortMain {
  return { close: vi.fn(), start: vi.fn() } as unknown as MessagePortMain;
}

const sender = { mainFrame: {} } as WebContents;

describe("acceptRpcPort", () => {
  it("upgrades a single port from an own window", () => {
    const port = fakePort();
    const upgrade = vi.fn();

    const accepted = acceptRpcPort(
      { ports: [port], sender, senderFrame: sender.mainFrame },
      () => true,
      upgrade
    );

    expect(accepted).toBe(true);
    expect(upgrade).toHaveBeenCalledWith(port);
  });

  it("closes the port when the sender is not an own window", () => {
    const port = fakePort();
    const upgrade = vi.fn();

    const accepted = acceptRpcPort(
      { ports: [port], sender, senderFrame: sender.mainFrame },
      () => false,
      upgrade
    );

    expect(accepted).toBe(false);
    expect(port.close).toHaveBeenCalledOnce();
    expect(upgrade).not.toHaveBeenCalled();
  });

  it("ignores events without exactly one port", () => {
    const upgrade = vi.fn();

    expect(
      acceptRpcPort(
        { ports: [], sender, senderFrame: sender.mainFrame },
        () => true,
        upgrade
      )
    ).toBe(false);
    expect(
      acceptRpcPort(
        {
          ports: [fakePort(), fakePort()],
          sender,
          senderFrame: sender.mainFrame,
        },
        () => true,
        upgrade
      )
    ).toBe(false);
    expect(upgrade).not.toHaveBeenCalled();
  });
});

it("rejects a subframe even when it belongs to an own window", () => {
  const port = fakePort();
  const upgrade = vi.fn();
  expect(
    acceptRpcPort(
      { ports: [port], sender, senderFrame: null },
      () => true,
      upgrade
    )
  ).toBe(false);
  expect(port.close).toHaveBeenCalledOnce();
  expect(upgrade).not.toHaveBeenCalled();
});
