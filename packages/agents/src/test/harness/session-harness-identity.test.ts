import type { AccessRequest } from "@foundry/authorization";
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createMemoryAuthorization,
  HOST_APPROVER,
} from "../../authorization/authorization";
import { SessionHarness } from "../../harness/session-harness";
import { Sessions } from "../../session/sessions";
import { MemorySessionStore } from "../../store/memory";
import {
  createScriptedMockModel,
  textStreamResult,
  toolCallStreamResult,
} from "../helpers/mock-language-model";
import { recordingStore } from "../helpers/recording-store";

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
    const authorization = createMemoryAuthorization();
    const requests: AccessRequest[] = [];
    const originalCheck = authorization.check.bind(authorization);
    vi.spyOn(authorization, "check").mockImplementation((request) => {
      requests.push(request);
      return originalCheck(request);
    });
    const store = new MemorySessionStore();
    const harness = new SessionHarness({
      authorization,
      instructions: "x",
      model: createScriptedMockModel({
        stream: [
          toolCallStreamResult("call-1", "probe", {}),
          textStreamResult("done"),
        ],
      }),
      store,
      tools: probeTools(),
    });

    await harness.generate("go");

    const [first] = requests;
    if (!first) {
      throw new Error("the tool call was never authorized");
    }
    expect(harness.sessionId).not.toBe("");
    expect(first.sessionId).toBe(harness.sessionId);
    expect(await store.getSession(harness.sessionId)).toBeTruthy();

    await authorization.grant({
      holder: {
        kind: "exact",
        principal: { id: first.principal.id, kind: first.principal.kind },
      },
      issuer: HOST_APPROVER,
      requestedBy: first.principal,
      scope: {
        action: first.action,
        target: { kind: "exact", value: first.target },
      },
      sessionId: first.sessionId,
    });
    await expect(authorization.check(first)).resolves.toMatchObject({
      kind: "allow",
    });
  });

  it("adopts an id the host already filed without creating the session again", async () => {
    const inner = new MemorySessionStore();
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
