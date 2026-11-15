import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  AgentAuthorizationRequest,
  AgentAuthorizer,
} from "../../authorization/authorization";
import { createInMemoryAgentAuthorizer } from "../../authorization/authorization";
import { SessionHarness } from "../../harness/session-harness";
import { Sessions } from "../../session/sessions";
import { InMemorySessionStore } from "../../store/memory";
import {
  createScriptedMockModel,
  textStreamResult,
  toolCallStreamResult,
} from "../helpers/mock-language-model";
import { recordingStore } from "../helpers/recording-store";

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
    const inner = new InMemorySessionStore();
    const filed = await new Sessions({ store: inner }).createSession({
      id: "filed",
      title: "host",
    });
    const { store, writes } = recordingStore(inner);
    const harness = new SessionHarness({
      instructions: "x",
      model: createScriptedMockModel({ stream: [textStreamResult("hi")] }),
      sessionId: "filed",
      store,
    });

    await harness.generate("go");

    expect(writes.filter((write) => write.putMessages === undefined)).toEqual(
      []
    );
    // Each append carried the session, changing nothing but its stamp.
    const carried = writes.flatMap((write) => write.putSessions ?? []);
    expect(carried).toHaveLength(2);
    for (const record of carried) {
      expect(record).toEqual({ ...filed, updatedAt: record.updatedAt });
    }
    expect(await store.getSession("filed")).toMatchObject({ title: "host" });
    expect((await store.listMessages("filed")).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it('mints an id for an empty one rather than sharing the session ""', () => {
    const settings = {
      instructions: "x",
      model: createScriptedMockModel({}),
      sessionId: "",
    };

    const first = new SessionHarness(settings);
    const second = new SessionHarness(settings);

    expect(first.sessionId).not.toBe("");
    expect(first.sessionId).not.toBe(second.sessionId);
  });
});
