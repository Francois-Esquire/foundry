import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { BrowserWindow, ipcMain, type MessagePortMain } from "electron";
import { RPC_CHANNELS } from "~/shared/rpc";
import type { RouterContext } from "./context";
import { router } from "./router";

export interface RpcPortEvent {
  ports: MessagePortMain[];
  sender: Electron.WebContents;
  senderFrame: Electron.WebFrameMain | null;
}

export type UpgradePort = (port: MessagePortMain) => void;

/**
 * Decide whether a port-start event may become an RPC connection. Only a
 * window this process created can connect, and it must send exactly one port.
 */
export function acceptRpcPort(
  event: RpcPortEvent,
  isOwnWindow: (sender: Electron.WebContents) => boolean,
  upgrade: UpgradePort
): boolean {
  const [port] = event.ports;
  if (port === undefined || event.ports.length !== 1) {
    return false;
  }
  if (
    !isOwnWindow(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    port.close();
    return false;
  }
  upgrade(port);
  return true;
}

/** Serve the router to every renderer that completes the port handshake. */
export function registerRpcTransport(context: RouterContext): void {
  const handler = new RPCHandler(router, {
    interceptors: [
      onError((error) => {
        process.stderr.write(`[works rpc] ${String(error)}\n`);
      }),
    ],
  });

  ipcMain.on(RPC_CHANNELS.serverStart, (event) => {
    acceptRpcPort(
      event,
      (sender) => BrowserWindow.fromWebContents(sender) !== null,
      (port) => {
        handler.upgrade(port, { context });
        port.start();
      }
    );
  });
}
