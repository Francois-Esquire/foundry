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

/**
 * Preload-side half of the handshake. Accepts only a message the renderer's own
 * window posted with the client-start name and exactly one port. The origin is
 * not checked: a packaged renderer is a file:// document whose origin is
 * opaque, so the source identity is the trustworthy signal.
 *
 * Returns true when a port was forwarded.
 */
export interface RpcPortMessage {
  data: unknown;
  ports: readonly MessagePort[];
  source: unknown;
}

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
