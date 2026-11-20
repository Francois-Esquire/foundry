import type { RealtimeClient } from "@fal-ai/client";

import { createFalClient } from "@fal-ai/client";

export interface FalEndpointClient {
  readonly realtime: Pick<RealtimeClient, "connect" | "open">;
  readonly storage: {
    upload(file: Blob): Promise<string>;
  };
  subscribe(
    endpointId: string,
    options: {
      input: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }
  ): Promise<{ data: unknown; requestId: string }>;
}

export type FalFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface FalRuntime {
  readonly client: FalEndpointClient;
  readonly credentials: string;
  readonly fetch: FalFetch;
}

export function buildFalRuntime(
  credentials: string,
  fetchImpl: FalFetch = (input, init) => globalThis.fetch(input, init)
): FalRuntime {
  return {
    client: createFalClient({ credentials }),
    credentials,
    fetch: fetchImpl,
  };
}
