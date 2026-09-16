import { tool } from "ai";
import { z } from "zod";

import type { Capability } from "../authorization";

import { tagTool } from "../harness/types";

/** Response bodies are clipped here so one page can't flood a turn. */
export const WEB_FETCH_MAX_BODY_CHARS = 50_000;

const FETCH_TIMEOUT_MS = 30_000;

/** The slice of `fetch` the tool uses (testable seam). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const webFetchInputSchema = z.object({
  url: z.string().describe("Absolute http(s) URL to fetch"),
});

export interface CreateWebFetchToolsOptions {
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

/**
 * Derive the `web.fetch{domain}` capability from a raw (not-yet-validated)
 * call — pure, so it can run ahead of the tool's own URL validation (design:
 * "Tool registration"). An unparseable/missing URL falls back to an empty
 * domain: the policy authorizes against it, then the tool's own validation
 * below still refuses to fetch, so nothing is gained by guessing.
 */
function domainOf(input: unknown): string {
  const parsed = webFetchInputSchema.safeParse(input);
  if (!parsed.success) {
    return "";
  }
  try {
    return new URL(parsed.data.url).hostname;
  } catch {
    return "";
  }
}

/**
 * The web-fetch tool: fetch a public http(s) URL as text. Carries the
 * `web.fetch{domain}` capability as its tool metadata — the harness's policy
 * decides allow/ask/deny before this file's `execute` ever runs; a denial
 * never reaches the fetch below. This file owns only the URL validation and
 * the fetch itself.
 */
export function createWebFetchTools(opts: CreateWebFetchToolsOptions = {}) {
  const { fetchImpl = fetch } = opts;

  const web_fetch = tool({
    description:
      "Fetch a public http(s) URL and return the response body as text. " +
      "Fetching from a new domain may pause while the user is asked to allow it; " +
      "a denial is final for this session — do not retry the same domain.",
    execute: async ({ url }, { abortSignal }) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { error: `Not an absolute URL: ${url}`, ok: false as const };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {
          error: `Unsupported protocol "${parsed.protocol}" — only http(s) URLs can be fetched.`,
          ok: false as const,
        };
      }

      const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
      if (abortSignal) {
        signals.push(abortSignal);
      }
      let response: Response;
      try {
        response = await fetchImpl(url, {
          redirect: "follow",
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        return {
          error: `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          ok: false as const,
        };
      }

      const body = await response.text();
      return {
        body: body.slice(0, WEB_FETCH_MAX_BODY_CHARS),
        contentType: response.headers.get("content-type") ?? "",
        ok: true as const,
        status: response.status,
        truncated: body.length > WEB_FETCH_MAX_BODY_CHARS,
      };
    },
    inputSchema: webFetchInputSchema,
  });

  const capability = (input: unknown): Capability => ({
    domain: domainOf(input),
    kind: "web.fetch",
  });

  return {
    tools: { web_fetch: tagTool(web_fetch, { capability, source: "builtin" }) },
  };
}
