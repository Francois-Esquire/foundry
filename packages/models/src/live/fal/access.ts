import { createFalClient } from "@fal-ai/client";
import type { FalEndpointClient } from "../../providers/fal/client";
import type { LiveAccess } from "../types";

export type FalClientFactory = (
  config: Parameters<typeof createFalClient>[0]
) => FalEndpointClient;

export function falClientFor(
  access: LiveAccess,
  create: FalClientFactory = createFalClient
): FalEndpointClient {
  if (access.kind === "credential") {
    return create({ credentials: access.credentials });
  }
  return create(
    access.kind === "proxy"
      ? { credentials: "", proxyUrl: { url: access.url, when: "always" } }
      : { credentials: "" }
  );
}
