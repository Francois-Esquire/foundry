import type { RealtimeClient } from "@fal-ai/client";

import { createFalClient } from "@fal-ai/client";

/**
 * The slice of the pinned `@fal-ai/client` this Provider uses. Declaring it
 * structurally is what lets {@link buildFalRuntime} prove at compile time that
 * the pinned client still carries `subscribe` and `storage.upload`, while
 * `media.ts` stays free of the endpoint-keyed generics (and their `any`
 * results) that the full `FalClient` exposes for unknown endpoint ids.
 */
export interface FalEndpointClient {
  /**
   * The live entries reach the configured client only through this member, and
   * only for `{ kind: "credential" }`. It is what lets them authenticate inside
   * the key-owning process without touching {@link FalRuntime.credentials}.
   */
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

/** The request seam the token mint and the result downloads use. */
export type FalFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Everything the FAL modules need from a configured client. `credentials` is
 * held because the client itself needs it and the token mint reaches FAL's REST
 * endpoint directly; it never leaves this package.
 */
export interface FalRuntime {
  readonly client: FalEndpointClient;
  readonly credentials: string;
  readonly fetch: FalFetch;
}

let runtime: FalRuntime | null = null;

/** Empty until `falProvider.configure` supplies a key; cleared when it is removed. */
export function getFalRuntime(): FalRuntime | null {
  return runtime;
}

export function setFalRuntime(next: FalRuntime | null): void {
  runtime = next;
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
