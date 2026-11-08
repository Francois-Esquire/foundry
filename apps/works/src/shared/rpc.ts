/**
 * The renderer and the main process talk oRPC over a MessagePort. The port is
 * born in the renderer, handed to the preload with window.postMessage, and
 * forwarded by the preload to main with ipcRenderer.postMessage. These are the
 * two message names that travel with it.
 */
export const RPC_CHANNELS = {
  clientStart: "works:rpc:client-start",
  serverStart: "works:rpc:server-start",
} as const;

export interface RpcPortMessage {
  data: unknown;
  ports: readonly MessagePort[];
  source: unknown;
}

/**
 * Accepts only a message from the renderer's own window with the client-start
 * name and exactly one port. Packaged file:// documents have opaque origins,
 * so the source is checked instead. Returns true when a port was forwarded.
 */
export function forwardRpcPort(
  event: RpcPortMessage,
  ownWindow: unknown,
  forward: (port: MessagePort) => void
): boolean {
  if (event.source !== ownWindow || event.data !== RPC_CHANNELS.clientStart) {
    return false;
  }
  const [port] = event.ports;
  if (port === undefined || event.ports.length !== 1) {
    return false;
  }
  forward(port);
  return true;
}
