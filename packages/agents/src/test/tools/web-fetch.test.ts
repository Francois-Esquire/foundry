import type { ToolExecutionOptions } from "ai";

import { describe, expect, it, vi } from "vitest";
import {
  agentSubject,
  createInMemoryAgentAuthorizer,
  describeCapability,
} from "../../authorization";
import { directToolEffectPort } from "../../harness/effect-port";
import { compileTool } from "../../harness/tool-compiler";
import { registrationsOf } from "../../harness/types";
import type { FetchLike } from "../../tools/web-fetch";
import {
  createWebFetchTools,
  WEB_FETCH_MAX_BODY_CHARS,
} from "../../tools/web-fetch";
import { fakeAuthorizer as fakePolicy } from "../helpers/authorizer";

const callOptions: ToolExecutionOptions<unknown> = {
  context: undefined,
  messages: [],
  toolCallId: "call-1",
};

function textResponse(body: string, init?: ResponseInit) {
  return new Response(body, {
    headers: { "content-type": "text/html" },
    status: 200,
    ...init,
  });
}

type WebFetchResult =
  | {
      ok: true;
      status: number;
      contentType: string;
      truncated: boolean;
      body: string;
    }
  | { ok: false; error: string };

function isWebFetchResult(value: unknown): value is WebFetchResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

/** Direct, uncompiled tool execute — exercises only this file's own URL
 *  validation and fetch, with no policy in front of it (matches how the
 *  compiler calls `execute` once a call is already authorized). */
function build(fetchImpl: FetchLike) {
  const { tools } = createWebFetchTools({ fetchImpl });
  const registration = registrationsOf(tools, "builtin")[0];
  if (!registration) {
    throw new Error("no web_fetch registration");
  }
  const rawExecute = registration.tool.execute;
  if (!rawExecute) {
    throw new Error("web_fetch tool has no execute");
  }
  return {
    execute: async (
      input: { url: string },
      opts: ToolExecutionOptions<unknown>
    ): Promise<WebFetchResult> => {
      const result: unknown = await rawExecute(input, opts);
      if (!isWebFetchResult(result)) {
        throw new Error("web_fetch returned an unexpected streaming result");
      }
      return result;
    },
    registration,
  };
}

describe("createWebFetchTools — tool behavior", () => {
  it("fetches and returns the body", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(textResponse("<h1>hi</h1>"));
    const { execute } = build(fetchImpl);

    const result = await execute(
      { url: "https://example.com/page?q=1" },
      callOptions
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      body: "<h1>hi</h1>",
      contentType: "text/html",
      ok: true,
      status: 200,
      truncated: false,
    });
  });

  it("rejects invalid and non-http(s) URLs without fetching", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const { execute } = build(fetchImpl);

    const invalid = await execute({ url: "not a url" }, callOptions);
    const fileUrl = await execute({ url: "file:///etc/passwd" }, callOptions);

    expect(invalid).toMatchObject({ ok: false });
    expect(fileUrl).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clips oversized bodies and flags truncation", async () => {
    const body = "x".repeat(WEB_FETCH_MAX_BODY_CHARS + 10);
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(textResponse(body));
    const { execute } = build(fetchImpl);

    const result = await execute(
      { url: "http://example.com/big" },
      callOptions
    );

    if (!result.ok) {
      throw new Error(`fetch result not ok: ${result.error}`);
    }
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(WEB_FETCH_MAX_BODY_CHARS);
  });

  it("returns a fetch failure as an error result, not a throw", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(new Error("boom"));
    const { execute } = build(fetchImpl);

    const result = await execute({ url: "https://example.com/" }, callOptions);

    expect(result).toEqual({ error: "Fetch failed: boom", ok: false });
  });
});

describe("createWebFetchTools — capability", () => {
  it("derives the exact prior web.fetch{domain} capability key from the URL", () => {
    const { registration } = build(vi.fn<FetchLike>());
    const capability = registration.capability(
      { url: "https://example.com/page?q=1" },
      { agentId: "a1", messages: [], toolCallId: "c1" }
    );
    expect(capability).toEqual({ domain: "example.com", kind: "web.fetch" });
    expect(describeCapability(capability)).toBe("web.fetch::example.com");
  });

  it("falls back to an empty domain for an unparseable URL, never throwing", () => {
    const { registration } = build(vi.fn<FetchLike>());
    expect(
      registration.capability("not an object", {
        agentId: "a1",
        messages: [],
        toolCallId: "c1",
      })
    ).toEqual({ domain: "", kind: "web.fetch" });
  });
});

describe("createWebFetchTools — through the compiler", () => {
  it("allow: fetches through the effect port", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(textResponse("<h1>hi</h1>"));
    const { registration } = build(fetchImpl);

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
    });

    const result: unknown = await compiled.execute?.(
      { url: "https://example.com" },
      callOptions
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true });
  });

  it("deny: never reaches fetch", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const { registration } = build(fetchImpl);

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({
        kind: "deny",
        reason: "no domain access",
        source: "policy",
      })),
    });

    const result: unknown = await compiled.execute?.(
      { url: "https://blocked.example/secret" },
      callOptions
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ approved: false, reason: "no domain access" });
  });

  it("ask: needsApproval reports true and a defensive execute still denies before fetching", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const { registration } = build(fetchImpl);

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "requires-approval" })),
    });

    // eslint-disable-next-line @typescript-eslint/no-deprecated -- ai v7 moves tool approval to the call level; the harness still owns approval today (deferred migration)
    const needsApproval = compiled.needsApproval as (
      input: unknown,
      options: unknown
    ) => Promise<boolean>;
    const needs = await needsApproval(
      { url: "https://example.com" },
      callOptions
    );
    expect(needs).toBe(true);

    const result: unknown = await compiled.execute?.(
      { url: "https://example.com" },
      callOptions
    );
    expect(result).toMatchObject({ approved: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("revoked continuation: a grant revoked before execute denies without fetching", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const { registration } = build(fetchImpl);

    let mode: "allow" | "deny" = "allow";
    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() =>
        mode === "allow"
          ? { kind: "allow", source: "grant" }
          : { kind: "deny", reason: "revoked", source: "policy" }
      ),
    });

    mode = "deny";
    const result: unknown = await compiled.execute?.(
      { url: "https://example.com" },
      callOptions
    );

    expect(result).toEqual({ approved: false, reason: "revoked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a real per-domain AgentAuthorizer allows an allowlisted domain and fails closed on an unlisted one", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(textResponse("hi"));
    const { registration } = build(fetchImpl);
    const policy = createInMemoryAgentAuthorizer({
      policy: { global: "deny" },
    });
    // A Grant for one exact domain, held by this exact agent Subject.
    await policy.allow(agentSubject("a1"), {
      domain: "allowed.example",
      kind: "web.fetch",
    });

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: policy.authorizer,
    });

    const allowed: unknown = await compiled.execute?.(
      { url: "https://allowed.example/page" },
      callOptions
    );
    expect(allowed).toMatchObject({ ok: true });

    const denied: unknown = await compiled.execute?.(
      { url: "https://unlisted.example/page" },
      callOptions
    );
    expect(denied).toMatchObject({ approved: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
