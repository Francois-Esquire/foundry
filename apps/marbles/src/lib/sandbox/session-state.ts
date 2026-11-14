import { Sessions } from "@foundry/agents/session";
import type { SessionStore } from "@foundry/agents/store";

/**
 * Refuse native resume when the VM containing its CLI history was replaced.
 * `containerId` is the guest's native id, which the caller has checked. The
 * session may not be in the store yet (a caller-supplied session ref is not
 * filed before it opens), so it is created here before the first note.
 */
export async function assertGuestSessionState(
  store: SessionStore,
  sessionId: string,
  harness: string,
  containerId: string
): Promise<void> {
  const messages = await store.listMessages(sessionId);
  const environment = messages
    .map((message) => message.metadata?.harnessEnvironment)
    .reverse()
    .find((value) => value?.harness === harness);
  const hasNativeHistory = messages.some((message) =>
    message.parts.some(
      (part) => part.type === "harness_session" && part.harness === harness
    )
  );
  if (hasNativeHistory && environment?.id !== containerId) {
    throw new Error(
      `Native history unavailable for ${harness} session "${sessionId}". Keep its sandbox open or start a new session; a replacement VM cannot resume the old CLI history.`
    );
  }
  if (environment?.id === containerId) {
    return;
  }
  const sessions = new Sessions({ store });
  if (!(await sessions.getSession(sessionId))) {
    await sessions.createSession({ id: sessionId });
  }
  await sessions.appendMessage({
    metadata: { harnessEnvironment: { harness, id: containerId } },
    parts: [],
    role: "system",
    sessionId,
  });
}
