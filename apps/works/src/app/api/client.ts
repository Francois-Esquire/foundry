import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
// Type only: the router's runtime lives in the main process and never ships
// in the renderer bundle.
import type { AppRouter } from "~/main/router/root";
import { RPC_CHANNELS } from "~/shared/rpc";

export type WorksClient = RouterClient<AppRouter>;

export type WorksApi = ReturnType<typeof createTanstackQueryUtils<WorksClient>>;

/**
 * Open a MessagePort to the main process and build the typed client on it.
 * The renderer keeps one end; the other goes to the preload, which forwards it
 * to main. Messages queue on the port until main upgrades it, so the client is
 * usable immediately.
 */
function connectWorksClient(): WorksClient {
  const { port1: clientPort, port2: serverPort } = new MessageChannel();
  window.postMessage(RPC_CHANNELS.clientStart, "*", [serverPort]);
  const link = new RPCLink({ port: clientPort });
  clientPort.start();
  return createORPCClient(link);
}

let api: WorksApi | undefined;

/** The TanStack Query utilities over the app's single client. Lazy, so a tree
 *  rendered outside Electron (tests, previews) only connects if it asks. */
export function worksApi(): WorksApi {
  api ??= createTanstackQueryUtils(connectWorksClient());
  return api;
}
