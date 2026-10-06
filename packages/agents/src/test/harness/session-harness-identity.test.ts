import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  AgentAuthorizationRequest,
  AgentAuthorizer,
} from "../../authorization/authorization";
import { createInMemoryAgentAuthorizer } from "../../authorization/authorization";
import { SessionHarness } from "../../harness/session-harness";
import { InMemorySessionStore } from "../../session/store";
import {
  createScriptedMockModel,
  textStreamResult,
  toolCallStreamResult,
} from "../helpers/mock-language-model";

/** `authorizer`, recording every request it is asked to decide. */
function recording(
  authorizer: AgentAuthorizer,
  requests: AgentAuthorizationRequest[]
): AgentAuthorizer {
  return {
    ...authorizer,
    decide: (request) => {
      requests.push(request);
      return authorizer.decide(request);
    },
  };
}

function probeTools() {
  return {
    probe: tool({
      description: "probe",
      execute: () => "ok",
      inputSchema: z.object({}),
    }),
  };
}

describe("SessionHarness — session identity", () => {
  it("scopes the first tool call by a session id minted at construction, so a session approval can be granted", async () => {
    const { authorizer } = createInMemoryAgentAuthorizer({
      policy: { byKind: { "tool.call": "ask" }, global: "ask" },
    });
    const requests: AgentAuthorizationRequest[] = [];
    const store = new InMemorySessionStore();
    const harness = new SessionHarness({
      instructions: "x",
      model: createScriptedMockModel({
        stream: [
          toolCallStreamResult("call-1", "probe", {}),
          textStreamResult("done"),
        ],
      }),
      policy: recording(authorizer, requests),
      store,
      tools: probeTools(),
    });

    await harness.generate("go");

    const [first] = requests;
    if (!first) {
      throw new Error("the tool call was never authorized");
    }
    expect(harness.sessionId).not.toBe("");
    expect(first.scopeId).toBe(harness.sessionId);
    expect(await store.getSession(harness.sessionId)).toBeTruthy();
    // A session-lifetime approval is refused without a scope; with one it is
    // granted, and the Grant matches the next call in the same session.
    await expect(
      authorizer.resolveApproval(first, { approved: true, lifetime: "session" })
    ).resolves.toMatchObject({ kind: "allow" });
    await expect(authorizer.decide(first)).resolves.toMatchObject({
      kind: "allow",
    });
  });

  it("adopts an id the host already filed without creating the session again", async () => {
    const store = new InMemorySessionStore();
    await store.createSession({ id: "filed", title: "host" });
    const create = vi.spyOn(store, "createSession");
    const harness = new SessionHarness({
      instructions: "x",
      model: createScriptedMockModel({ stream: [textStreamResult("hi")] }),
      sessionId: "filed",
      store,
    });

    await harness.generate("go");

    expect(create).not.toHaveBeenCalled();
    expect(await store.getSession("filed")).toMatchObject({ title: "host" });
    expect((await store.listMessages("filed")).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});
