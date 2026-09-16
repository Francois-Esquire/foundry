import { defineErrorCatalog } from "evlog";

export const modelErrors = defineErrorCatalog("models", {
  AIRPLANE_LOCAL_UNAVAILABLE: {
    fix: "Install the required local model from Local Models setup, or disable Airplane Mode to use cloud providers again.",
    message: ({ kind, reason }: { kind: string; reason: string }) =>
      `Airplane Mode is enabled and the local provider cannot serve "${kind}": ${reason}. ` +
      "No cloud fallback was attempted — install the required local model, or disable Airplane Mode.",
    status: 503,
    why: 'Airplane Mode routes every request through the provider registered as "local" and never falls back to a cloud provider.',
  },
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
  MODEL_NOT_REGISTERED: {
    message: ({ model, provider }: { model: string; provider: string }) =>
      `Model "${model}" is not registered on provider "${provider}".`,
    status: 404,
  },
  NO_MODEL_OF_KIND: {
    message: ({ provider, kind }: { provider: string; kind: string }) =>
      `Provider "${provider}" has no ${kind} model registered.`,
    status: 404,
  },
  NO_USABLE_PROVIDER: {
    fix: "Add credentials for a cloud provider (e.g. a Vercel API key or a gateway API key) in settings.",
    message: ({ kind }: { kind: string }) =>
      `No credentialed provider can serve "${kind}".`,
    status: 503,
    why: "Every registered cloud provider for this kind is missing credentials, so none can actually make a request.",
  },
  PROVIDER_NOT_REGISTERED: {
    message: ({ provider }: { provider: string }) =>
      `Provider "${provider}" is not registered.`,
    status: 404,
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
