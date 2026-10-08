import { describe, expect, it, vi } from "vitest";
import { forwardRpcPort, RPC_CHANNELS } from "~/shared/rpc";

const ownWindow = { name: "own" };
const port = { name: "port" } as unknown as MessagePort;

describe("forwardRpcPort", () => {
  it("forwards the port from the window's own start message", () => {
    const forward = vi.fn();

    const result = forwardRpcPort(
      { data: RPC_CHANNELS.clientStart, ports: [port], source: ownWindow },
      ownWindow,
      forward
    );

    expect(result).toBe(true);
    expect(forward).toHaveBeenCalledWith(port);
  });

  it("ignores messages from another source, name, or port count", () => {
    const forward = vi.fn();
    const cases = [
      { data: RPC_CHANNELS.clientStart, ports: [port], source: { name: "x" } },
      { data: "something-else", ports: [port], source: ownWindow },
      { data: RPC_CHANNELS.clientStart, ports: [], source: ownWindow },
      {
        data: RPC_CHANNELS.clientStart,
        ports: [port, port],
        source: ownWindow,
      },
    ];

    for (const event of cases) {
      expect(forwardRpcPort(event, ownWindow, forward)).toBe(false);
    }
    expect(forward).not.toHaveBeenCalled();
  });
});
