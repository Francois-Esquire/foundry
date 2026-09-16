import { afterEach, describe, expect, it } from "vitest";

import type { FalFetch } from "../fal/client";
import { setFalRuntime } from "../fal/client";
import { falProvider } from "../fal/provider";
import type { Provider } from "../provider";
import type { ProviderModelDefinition } from "../types";

const KEY = "fal_key_QZX7_never_leaves_the_provider_0987654321";
const TOKEN = "temporary-token-abc";

interface Sent {
  body: unknown;
  headers: Record<string, string>;
  method?: string;
  url: string;
}

const sent: Sent[] = [];

function stubFetch(
  respond: () => Response = () => Response.json(TOKEN)
): FalFetch {
  return (input, init) => {
    sent.push({
      url: input,
      ...(init?.method === undefined ? {} : { method: init.method }),
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve(respond());
  };
}

function keyed(
  overrides: {
    models?: ProviderModelDefinition[];
    proxyUrl?: string;
    respond?: () => Response;
  } = {}
): Provider {
  return falProvider({
    config: {
      apiKey: KEY,
      fetch: stubFetch(overrides.respond),
      ...(overrides.proxyUrl === undefined
        ? {}
        : { proxyUrl: overrides.proxyUrl }),
    },
    ...(overrides.models ? { models: overrides.models } : {}),
  });
}

/** One row bearing live facts for two Operations, plus a request-only fact. */
const TWO_LIVE: ProviderModelDefinition[] = [
  {
    id: "vendor/dual",
    kind: "video",
    modelId: "vendor/dual",
    operations: [
      {
        delivery: "result-per-input",
        inputs: ["frame"],
        mode: "live",
        operation: "generate-image",
        outputs: ["image/jpeg"],
        required: ["frame"],
      },
      {
        delivery: "continuous",
        inputs: ["direction"],
        mode: "live",
        operation: "generate-video",
        outputs: ["video/webm"],
        required: ["direction"],
      },
      {
        delivery: "whole",
        inputs: ["source-text"],
        mode: "request",
        operation: "generate-speech",
        outputs: ["audio/mpeg"],
        required: ["source-text"],
      },
    ],
  },
];

afterEach(() => {
  sent.length = 0;
  setFalRuntime(null);
});

describe("FAL grant", () => {
  it("mints a scoped, short-lived token that carries no key", async () => {
    const before = Date.now();
    const access = await keyed().grant?.(
      "fal-ai/flux-2/klein/realtime",
      "generate-image"
    );
    expect(access).toEqual({
      expiresAt: expect.any(Number) as number,
      kind: "token",
      token: TOKEN,
    });
    if (access?.kind !== "token") {
      throw new Error("unreachable");
    }
    expect(access.expiresAt).toBeGreaterThan(before);
    expect(JSON.stringify(access).includes(KEY)).toBe(false);
  });

  it("reproduces the client's own mint: rest.fal.ai, app alias, 120s", async () => {
    await keyed().grant?.("fal-ai/flux-2/klein/realtime", "generate-image");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://rest.fal.ai/tokens/");
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.headers.Authorization).toBe(`Key ${KEY}`);
    expect(sent[0]?.body).toEqual({
      allowed_apps: ["flux-2"],
      token_expiration: 120,
    });
  });

  it("accepts the wrapped token shape older proxies return", async () => {
    const access = await keyed({
      respond: () => Response.json({ detail: TOKEN }),
    }).grant?.("fal-ai/flux-2/klein/realtime", "generate-image");
    if (access?.kind !== "token") {
      throw new Error("unreachable");
    }
    expect(access.token).toBe(TOKEN);
  });

  it("keeps the key out of a failed mint", async () => {
    const provider = keyed({
      respond: () => new Response("nope", { status: 401 }),
    });
    await expect(
      provider.grant?.("fal-ai/flux-2/klein/realtime", "generate-image")
    ).rejects.toThrow(/status 401/);
    await provider
      .grant?.("fal-ai/flux-2/klein/realtime", "generate-image")
      .catch((error: unknown) => {
        expect(String(error).includes(KEY)).toBe(false);
      });
  });

  it("succeeds on a continuous row, since delivery never refuses a grant", async () => {
    const access = await keyed().grant?.(
      "minimax/h3-max/director",
      "generate-video"
    );
    expect(access?.kind).toBe("token");
  });

  it("returns a proxy instead of a token when the Provider is configured for one", async () => {
    const access = await keyed({ proxyUrl: "https://host/fal" }).grant?.(
      "fal-ai/flux-2/klein/realtime",
      "generate-image"
    );
    expect(access).toEqual({ kind: "proxy", url: "https://host/fal" });
    expect(sent).toHaveLength(0);
  });

  it("refuses NO_USABLE_PROVIDER without a key, before any mint", async () => {
    await expect(
      falProvider().grant?.("fal-ai/flux-2/klein/realtime", "generate-image")
    ).rejects.toThrow(/No credentialed provider/);
    expect(sent).toHaveLength(0);
  });

  it("refuses CAPABILITY_UNSUPPORTED for a row with only request facts", async () => {
    await expect(
      keyed().grant?.("fal-ai/sam-3/image", "segment-image")
    ).rejects.toThrow(/does not support the segment-image Operation in live/);
  });

  it("refuses MODEL_NOT_REGISTERED for an id the Provider does not carry", async () => {
    await expect(
      keyed().grant?.("vendor/unknown", "generate-image")
    ).rejects.toThrow(/is not registered on provider "fal"/);
  });

  it("answers each live Operation on a row bearing two, and refuses the request-only one", async () => {
    const provider = keyed({ models: TWO_LIVE });
    expect(
      (await provider.grant?.("vendor/dual", "generate-image"))?.kind
    ).toBe("token");
    expect(
      (await provider.grant?.("vendor/dual", "generate-video"))?.kind
    ).toBe("token");
    await expect(
      provider.grant?.("vendor/dual", "generate-speech")
    ).rejects.toThrow(/generate-speech Operation in live/);
  });
});
