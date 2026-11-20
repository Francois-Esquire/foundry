import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouter } from "~/main/api";
import { RPC_CHANNELS } from "~/shared/rpc";

export type WorksClient = RouterClient<AppRouter>;

export type WorksApi = ReturnType<typeof createTanstackQueryUtils<WorksClient>>;

function connectWorksClient(): WorksClient {
  const { port1: clientPort, port2: serverPort } = new MessageChannel();
  window.postMessage(RPC_CHANNELS.clientStart, "*", [serverPort]);
  const link = new RPCLink({ port: clientPort });
  clientPort.start();
  return createORPCClient(link);
}

let api: WorksApi | undefined;

export function worksApi(): WorksApi {
  api ??= createTanstackQueryUtils(connectWorksClient());
  return api;
}
