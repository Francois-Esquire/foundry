// Gateway behavior from Agents' packages/modules/src/template/index.ts.
export const MODULE_GATEWAY_SERVER = `
const gatewayModes = new WeakMap();
const closedSockets = [];
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/_foundry/module-gateway" && server.upgrade(request)) return;
    if (url.pathname === "/_foundry/health") {
      return Response.json({
        status: "ready",
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        connection: request.headers.get("connection"),
        closedSockets,
      });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    message(socket, message) {
      if (typeof message !== "string") {
        socket.close(1003, "Gateway accepts JSON text frames");
        return;
      }
      try {
        const frame = JSON.parse(message);
        if (
          typeof frame === "object" && frame !== null &&
          "kind" in frame && frame.kind === "heartbeat" && gatewayModes.has(socket)
        ) {
          socket.send(JSON.stringify({ kind: "heartbeat", sequence: frame.sequence }));
          return;
        }
        if (
          typeof frame !== "object" || frame === null || Array.isArray(frame) ||
          frame.kind !== "hello" || frame.protocol !== 1 ||
          (frame.mode !== "development" && frame.mode !== "runtime")
        ) {
          socket.close(1002, "Gateway hello is invalid");
          return;
        }
        gatewayModes.set(socket, frame.mode);
        socket.send(JSON.stringify({ kind: "ready", protocol: 1, mode: frame.mode }));
      } catch {
        socket.close(1007, "Gateway frame is not JSON");
      }
    },
    close(socket, code, reason) {
      gatewayModes.delete(socket);
      closedSockets.push({ code, reason });
    },
  },
});
process.stdout.write(String(server.port) + "\\n");
`;
