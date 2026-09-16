import { parseEndpointId } from "@fal-ai/client";
import { modelErrors } from "../errors";
import type { LiveAccess } from "../live/types";
import { operationsOf } from "../provider";
import type { OperationName, ProviderModelDefinition } from "../types";
import type { FalRuntime } from "./client";

/**
 * `./auth` is absent from the pinned client's `exports` map, so
 * `getTemporaryAuthToken` is unreachable and the mint reaches FAL's REST token
 * endpoint from inside the Provider. The scope and expiry below reproduce that
 * function exactly (`src/auth.js:17,29,30`, `getRestApiUrl` at
 * `src/config.js:78`), so a caller sees the same token the client would have
 * minted for itself.
 */
const FAL_REST_URL = "https://rest.fal.ai";
const TOKEN_EXPIRATION_SECONDS = 120;

export interface FalGrantRequest {
  readonly available: boolean;
  readonly modelId: string;
  readonly models: readonly ProviderModelDefinition[];
  readonly operation: OperationName;
  readonly providerId: string;
  readonly proxyUrl?: string;
  readonly runtime: FalRuntime | null;
}

/**
 * Live access for one Operation on one Model. `delivery` is deliberately not
 * consulted: the registry states the fact and stops there, so a grant on a
 * `continuous` row succeeds and the caller decides what to do with it.
 */
export async function falGrant(request: FalGrantRequest): Promise<LiveAccess> {
  const row = request.models.find((model) => model.id === request.modelId);
  if (!row) {
    throw modelErrors.MODEL_NOT_REGISTERED({
      model: request.modelId,
      provider: request.providerId,
    });
  }
  const fact = operationsOf(row).find(
    (candidate) =>
      candidate.mode === "live" && candidate.operation === request.operation
  );
  if (!fact) {
    throw modelErrors.CAPABILITY_UNSUPPORTED({
      capability: `the ${request.operation} Operation in live mode`,
      provider: request.providerId,
    });
  }
  if (!(request.available && request.runtime)) {
    throw modelErrors.NO_USABLE_PROVIDER({ kind: request.operation });
  }
  if (request.proxyUrl !== undefined) {
    return { kind: "proxy", url: request.proxyUrl };
  }
  return {
    expiresAt: Date.now() + TOKEN_EXPIRATION_SECONDS * 1000,
    kind: "token",
    token: await mint(request.runtime, row.modelId),
  };
}

async function mint(runtime: FalRuntime, endpointId: string): Promise<string> {
  const response = await runtime.fetch(`${FAL_REST_URL}/tokens/`, {
    body: JSON.stringify({
      allowed_apps: [parseEndpointId(endpointId).alias],
      token_expiration: TOKEN_EXPIRATION_SECONDS,
    }),
    headers: {
      Authorization: `Key ${runtime.credentials}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    // The status alone: a token-mint body can echo the request, and nothing
    // from this exchange may reach a log.
    throw new Error(
      `[fal] token minting failed with status ${String(response.status)}`
    );
  }
  const payload: unknown = await response.json();
  if (typeof payload === "string") {
    return payload;
  }
  // Old proxies wrap the token; the client tolerates both, so this does too.
  if (typeof payload === "object" && payload !== null) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string") {
      return detail;
    }
  }
  throw new Error("[fal] token minting returned no token");
}
