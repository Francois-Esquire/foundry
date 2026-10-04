import {
  InMemorySessionStore,
  normalizeMessageMetadata,
} from "@foundry/agents/session";
import { expect, it } from "vitest";
import { assertGuestSessionState } from "~/lib/sandbox/session-state";
import { JsonSessionStore } from "~/lib/sessions/json-store";

it("adopts a fresh session and preserves same-instance native resume", async () => {
  const store = new InMemorySessionStore();
  await assertGuestSessionState(store, "conversation", "codex", "guest-1");
  await store.appendMessage({
    parts: [
      {
        harness: "codex",
        nativeSessionId: "native-thread",
        type: "harness_session",
      },
    ],
    role: "system",
    sessionId: "conversation",
  });
  await assertGuestSessionState(store, "conversation", "codex", "guest-1");
  const messages = await store.listMessages("conversation");
  expect(messages).toHaveLength(2);
  expect(messages[0]?.metadata?.harnessEnvironment).toEqual({
    harness: "codex",
    id: "guest-1",
  });
});

it("refuses a replacement guest before a persisted native thread can resume", async () => {
  const store = new InMemorySessionStore();
  await assertGuestSessionState(
    store,
    "conversation",
    "claude-code",
    "guest-1"
  );
  await store.appendMessage({
    parts: [
      {
        harness: "claude-code",
        nativeSessionId: "native-thread",
        type: "harness_session",
      },
    ],
    role: "system",
    sessionId: "conversation",
  });
  await expect(
    assertGuestSessionState(store, "conversation", "claude-code", "guest-2")
  ).rejects.toThrow("Native history unavailable");
  expect(
    (await store.listMessages("conversation"))[0]?.metadata?.harnessEnvironment
      ?.id
  ).toBe("guest-1");
});

it("refuses native mappings without an environment marker", async () => {
  const store = new InMemorySessionStore();
  await store.createSession({ id: "conversation" });
  await store.appendMessage({
    parts: [
      {
        harness: "codex",
        nativeSessionId: "native-thread",
        type: "harness_session",
      },
    ],
    role: "system",
    sessionId: "conversation",
  });
  await expect(
    assertGuestSessionState(store, "conversation", "codex", "guest-1")
  ).rejects.toThrow("start a new session");
  expect(await store.listMessages("conversation")).toHaveLength(1);
});

it("permits replacement before native history exists and keeps harness markers separate", async () => {
  const store = new InMemorySessionStore();
  await assertGuestSessionState(store, "conversation", "codex", "guest-1");
  await assertGuestSessionState(store, "conversation", "codex", "guest-2");
  await store.appendMessage({
    parts: [
      {
        harness: "codex",
        nativeSessionId: "native-thread",
        type: "harness_session",
      },
    ],
    role: "system",
    sessionId: "conversation",
  });
  await assertGuestSessionState(
    store,
    "conversation",
    "claude-code",
    "guest-3"
  );
  await expect(
    assertGuestSessionState(store, "conversation", "codex", "guest-3")
  ).rejects.toThrow("Native history unavailable");
  await assertGuestSessionState(store, "conversation", "codex", "guest-2");
});

it("preserves environment identity through canonical metadata normalization", () => {
  expect(
    normalizeMessageMetadata({
      harnessEnvironment: { harness: "codex", id: "guest-1" },
    })
  ).toEqual({ harnessEnvironment: { harness: "codex", id: "guest-1" } });
});

it("keeps instance identity across a durable store reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guest-session-state-"));
  try {
    const store = new JsonSessionStore(directory);
    await assertGuestSessionState(store, "conversation", "codex", "guest-1");
    await store.appendMessage({
      parts: [
        {
          harness: "codex",
          nativeSessionId: "native-thread",
          type: "harness_session",
        },
      ],
      role: "system",
      sessionId: "conversation",
    });
    const reopened = new JsonSessionStore(directory);
    await assertGuestSessionState(reopened, "conversation", "codex", "guest-1");
    await expect(
      assertGuestSessionState(reopened, "conversation", "codex", "guest-2")
    ).rejects.toThrow("Native history unavailable");
    expect(await reopened.listMessages("conversation")).toHaveLength(2);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
