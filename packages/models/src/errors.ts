import { defineErrorCatalog } from "evlog";

export const modelErrors = defineErrorCatalog("models", {
  CAPABILITY_UNSUPPORTED: {
    message: ({
      provider,
      capability,
    }: {
      provider: string;
      capability: string;
    }) => `Provider "${provider}" does not support ${capability}.`,
    status: 501,
    why: "The provider does not implement the requested capability.",
  },
  CODE_GRAMMAR_DOWNLOAD_FAILED: {
    message: ({ language }: { language: string }) =>
      `[foundry/embeddings] failed to download the "${language}" tree-sitter grammar`,
    status: 502,
    why: "The code chunker fetches tree-sitter grammars on demand; this one could not be retrieved (offline/sandboxed, or an unknown language name). Pre-warm with downloadCodeLanguages, or pass an already-downloaded language.",
  },
  EMBEDDING_COUNT_MISMATCH: {
    message: ({ returned, expected }: { returned: number; expected: number }) =>
      `[foundry/embeddings] embedMany returned ${returned} embeddings for ${expected} values`,
    status: 500,
    why: "The embedding backend returned a different count than requested.",
  },
  INVALID_CHUNK_CUTOFF: {
    message: ({ maxChars }: { maxChars: number }) =>
      `fixed-cutoff requires maxChars > 0, got ${maxChars}`,
    status: 400,
  },
  INVALID_CHUNK_OVERLAP: {
    message: ({ overlap, maxChars }: { overlap: number; maxChars: number }) =>
      `fixed-cutoff requires 0 <= overlap < maxChars, got overlap ${overlap} for maxChars ${maxChars}`,
    status: 400,
  },
  INVALID_EMBEDDING_JSON: {
    message: "Invalid embedding JSON: expected number array",
    status: 400,
  },
  LIVE_ACCESS_UNAVAILABLE: {
    message: ({ reason }: { reason: string }) =>
      `The supplied live access cannot be used: ${reason}.`,
    status: 403,
  },
  LIVE_OPEN_REFUSED: {
    message: ({ reason }: { reason: string }) =>
      `A live interaction cannot be opened: ${reason}.`,
    status: 422,
    why: "The Capability fact, the access, or the supplied options do not describe a session this Model can hold.",
  },
  LIVE_RECORDING_REFUSED: {
    message: ({ reason }: { reason: string }) =>
      `A live recording cannot start: ${reason}.`,
    status: 409,
    why: "Recording muxes received RTP and never decodes, so anything the webm writer cannot carry is refused rather than transcoded.",
  },
  MODEL_KIND_MISMATCH: {
    message: ({
      provider,
      model,
      actual,
      expected,
    }: {
      provider: string;
      model: string;
      actual: string;
      expected: string;
    }) =>
      `Provider "${provider}" model "${model}" is kind "${actual}", expected "${expected}".`,
    status: 422,
  },
  MODEL_NOT_FOUND: {
    message: ({
      model,
      searched,
      skipped,
    }: {
      model: string;
      searched: readonly string[];
      skipped?: string;
    }) =>
      `No configured provider lists "${model}" (searched: ${searched.join(", ") || "none"}${skipped ? `; skipped: ${skipped}` : ""}).`,
    status: 404,
    why: "Selections are checked against each provider's catalog; an id no catalog lists is refused rather than passed through.",
  },
  NO_MODEL_OF_KIND: {
    message: ({ provider, kind }: { provider: string; kind: string }) =>
      `Provider "${provider}" has no ${kind} model registered.`,
    status: 404,
  },
  PROVIDER_NOT_CONFIGURED: {
    message: ({ provider }: { provider: string }) =>
      `Provider "${provider}" is not configured here.`,
    status: 404,
  },
  PROVIDER_OFFLINE: {
    message: ({ provider }: { provider: string }) =>
      `Provider "${provider}" is offline and refuses calls.`,
    status: 503,
    why: "Airplane Mode took this provider offline; it reaches the network again only once switched back online.",
  },
  PROVIDER_OFFLINE_UNCONFIRMED: {
    message: ({ provider, reason }: { provider: string; reason: string }) =>
      `Provider "${provider}" could not confirm it went offline: ${reason}.`,
    status: 500,
    why: "Going offline must stop what outlives a call; this provider could not show that it did, so callers keep refusing it.",
  },
  PROVIDER_RESTRICTED: {
    message: ({
      policy,
      provider,
      reason,
    }: {
      policy: string;
      provider: string;
      reason: string;
    }) => `Provider "${provider}" is refused by ${policy}: ${reason}.`,
    status: 403,
    why: "A policy installed on this manager refuses the provider; nothing reaches it until the policy lifts.",
  },
  PROVIDER_UNAVAILABLE: {
    message: ({ kind, provider }: { kind: string; provider?: string }) =>
      provider === undefined
        ? `No available provider serves "${kind}".`
        : `Provider "${provider}" is unavailable.`,
    status: 503,
  },
  ROUTE_STALE: {
    message: ({ model, provider }: { model: string; provider: string }) =>
      `The route ${provider}/${model} left the provider set before it was opened.`,
    status: 409,
  },
  SELECTION_AMBIGUOUS: {
    message: ({ selection }: { selection: string }) =>
      `"${selection}" names a provider and model and also a model id; name it as { provider, model } instead.`,
    status: 409,
  },
  WEBRTC_UNAVAILABLE: {
    fix: "Run the session in a process where @foundry/models/live/node can install its runtime, or in a browser that provides WebRTC natively.",
    message: ({ symbol }: { symbol: string }) =>
      `No WebRTC runtime could supply "${symbol}".`,
    status: 503,
    why: "A continuous live session needs WebRTC symbols on globalThis, and this one could not be installed.",
  },
});

declare module "evlog" {
  interface RegisteredErrorCatalogs {
    models: typeof modelErrors;
  }
}
