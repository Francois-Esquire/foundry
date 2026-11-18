import { createFalClient } from "@fal-ai/client";
import type { FalEndpointClient } from "../fal/client";
import type { LiveAccess } from "./types";

export function falClientFor(access: LiveAccess): FalEndpointClient {
  if (access.kind === "credential") {
    return access.client;
  }
  return createFalClient(
    access.kind === "proxy"
      ? { credentials: "", proxyUrl: { url: access.url, when: "always" } }
      : { credentials: "" }
  ) satisfies FalEndpointClient;
}
