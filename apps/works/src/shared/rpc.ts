export const RPC_CHANNELS = {
  clientStart: "works:rpc:client-start",
  serverStart: "works:rpc:server-start",
} as const;

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
