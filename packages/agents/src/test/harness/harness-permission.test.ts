import { describe, expect, it, vi } from "vitest";

import {
  agentSubject,
  createInMemoryAgentAuthorizer,
} from "../../authorization/authorization";
import {
  createHarnessPermission,
  redactHarnessSummary,
  resolveHarnessApproval,
  summarizeHarnessInput,
} from "../../harness/permission";
import type {
  HarnessAuthoritySettings,
  HarnessPermissionRequest,
} from "../../harness/turn-driver";
import { InMemorySessionStore } from "../../session/store";

function request(
  signal = new AbortController().signal
): HarnessPermissionRequest {
  return {
    input: { command: "echo API_KEY=private-value" },
    sessionId: "session-1",
    signal,
    toolCallId: "call-1",
    toolName: "Bash",
  };
}

async function setup(mode: "scheduled" | "attended" = "scheduled") {
  const authority = createInMemoryAgentAuthorizer();
  const store = new InMemorySessionStore();
  await store.createSession({ id: "session-1" });
  const settings: HarnessAuthoritySettings = {
    agentGeneration: 2,
    agentId: "coder",
    policy: authority.authorizer,
    profile: {
      allowedTools: [],
      disallowedTools: [],
      maxSteps: 30,
      mode,
      unresolved: "ask",
    },
    store,
  };
  return { authority, settings, store };
}

describe("native harness permission", () => {
  it("awaits deferred request publication before returning the denial", async () => {
    const { settings } = await setup();
    let publish!: () => void;
    settings.onApprovalRequest = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          publish = resolve;
        })
    );
    let finished = false;
    const pending = createHarnessPermission(settings)(request()).then(
      (result) => {
        finished = true;
        return result;
      }
    );
    await vi.waitFor(() =>
      expect(settings.onApprovalRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalMode: "deferred",
          sessionId: "session-1",
        })
      )
    );
    expect(finished).toBe(false);
    publish();
    expect(await pending).toMatchObject({ behavior: "deny" });
  });

  it("scheduled asks deny promptly, record identity, and remember a next-run grant", async () => {
    const { settings, store } = await setup();
    const approve = vi.fn(() => new Promise<never>(() => undefined));
    settings.approve = approve;
    const permission = createHarnessPermission(settings);
    expect(await permission(request())).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("Needs approval"),
    });
    expect(approve).not.toHaveBeenCalled();
    const history = await store.listMessages("session-1");
    const pending = history[0]?.parts[0];
    expect(pending).toMatchObject({
      agentGeneration: 2,
      agentId: "coder",
      capability: { kind: "tool.call", source: "harness", tool: "Bash" },
      type: "tool_approval_request",
    });
    expect(JSON.stringify(history)).not.toContain("private-value");
    if (pending?.type !== "tool_approval_request") {
      throw new Error("No approval");
    }
    await resolveHarnessApproval(settings, "session-1", pending.approvalId, {
      approved: true,
      lifetime: "persistent",
    });
    expect(await permission({ ...request(), toolCallId: "next-call" })).toEqual(
      { behavior: "allow" }
    );
  });

  it("attended waits for its host answer and writes the same remembered grant", async () => {
    const { settings } = await setup("attended");
    let answer!: (value: { approved: boolean; lifetime: "session" }) => void;
    settings.approve = vi.fn(
      () =>
        new Promise<{ approved: boolean; lifetime: "session" }>((resolve) => {
          answer = resolve;
        })
    );
    const pending = createHarnessPermission(settings)(request());
    await vi.waitFor(() => expect(settings.approve).toHaveBeenCalled());
    answer({ approved: true, lifetime: "session" });
    expect(await pending).toEqual({ behavior: "allow" });
    expect(
      await createHarnessPermission(settings)({
        ...request(),
        toolCallId: "next-call",
      })
    ).toEqual({ behavior: "allow" });
  });

  it("cancels a host answer that never arrives and never grants authority", async () => {
    const { settings, authority } = await setup("attended");
    settings.approve = vi.fn(() => new Promise<never>(() => undefined));
    const controller = new AbortController();
    const pending = createHarnessPermission(settings)(
      request(controller.signal)
    );
    const rejected = expect(pending).rejects.toThrow("interrupted");
    await vi.waitFor(() => expect(settings.approve).toHaveBeenCalled());
    controller.abort(new Error("interrupted"));
    await rejected;
    expect(
      await authority.authorizer.decide({
        capability: { kind: "tool.call", source: "harness", tool: "Bash" },
        invocationId: "next",
        subject: agentSubject("coder", 2),
      })
    ).toEqual({ kind: "requires-approval" });
  });

  it("retains explicit denial reasons and does not ask", async () => {
    const { settings } = await setup("attended");
    settings.policy = createInMemoryAgentAuthorizer({
      policy: { byKind: { "tool.call": "deny" }, global: "deny" },
    }).authorizer;
    settings.approve = vi.fn();
    expect(await createHarnessPermission(settings)(request())).toEqual({
      behavior: "deny",
      message: "Denied by capability kind policy.",
    });
    expect(settings.approve).not.toHaveBeenCalled();
  });

  it("refuses a deferred once approval and an approval for another generation", async () => {
    const { settings, store } = await setup();
    await createHarnessPermission(settings)(request());
    const part = (await store.listMessages("session-1"))[0]?.parts[0];
    if (part?.type !== "tool_approval_request") {
      throw new Error("No approval");
    }
    await expect(
      resolveHarnessApproval(settings, "session-1", part.approvalId, {
        approved: true,
      })
    ).rejects.toThrow("requires a session or persistent grant");
    await expect(
      resolveHarnessApproval(
        { ...settings, agentGeneration: 3 },
        "session-1",
        part.approvalId,
        { approved: true, lifetime: "persistent" }
      )
    ).rejects.toThrow("does not belong");
  });

  it("honors static allow prefixes but refuses compound shell escalation", async () => {
    const { settings } = await setup();
    settings.profile = {
      ...settings.profile,
      allowedTools: ["Bash(bun test:*)"],
    };
    const permission = createHarnessPermission(settings);
    expect(
      await permission({
        ...request(),
        input: { command: "bun test src/test" },
      })
    ).toEqual({ behavior: "allow" });
    for (const command of [
      "bun test; git push",
      "bun test && git push",
      "bun test $(git push)",
      "bun testing",
    ]) {
      expect(
        await permission({ ...request(), input: { command } })
      ).toMatchObject({ behavior: "deny" });
    }
  });

  it("static denies override grants and explicit policy denies override static allows", async () => {
    const { settings, authority } = await setup();
    await authority.allow(agentSubject("coder", 2), {
      kind: "tool.call",
      source: "harness",
      tool: "Bash",
    });
    settings.profile = {
      ...settings.profile,
      allowedTools: ["Bash"],
      disallowedTools: ["Bash(git push*)"],
    };
    expect(
      await createHarnessPermission(settings)({
        ...request(),
        input: { command: "git push https://example.test/repo" },
      })
    ).toEqual({ behavior: "deny", message: "Denied by harness profile." });
    settings.policy = createInMemoryAgentAuthorizer({
      policy: { byKind: { "tool.call": "deny" }, global: "deny" },
    }).authorizer;
    expect(
      await createHarnessPermission(settings)({
        ...request(),
        input: { command: "bun test" },
      })
    ).toEqual({
      behavior: "deny",
      message: "Denied by capability kind policy.",
    });
  });

  it("delivers exact sensitive input only to the attended approver", async () => {
    const { settings, store } = await setup("attended");
    settings.approve = vi.fn(async () => ({ approved: true }));
    settings.onApprovalRequest = vi.fn();
    await createHarnessPermission(settings)(request());
    expect(settings.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { command: "echo API_KEY=private-value" },
        inputSummary: "fields: command",
      })
    );
    expect(JSON.stringify(await store.listMessages("session-1"))).not.toContain(
      "private-value"
    );
    expect(
      JSON.stringify(vi.mocked(settings.onApprovalRequest).mock.calls)
    ).not.toContain("private-value");
  });

  it("shows a complete redacted operation when the live preview limit is Infinity", () => {
    const command = `echo ${"x".repeat(300)}; token=private-value; rm -rf /workspace`;
    expect(redactHarnessSummary(command)).toHaveLength(240);
    const preview = redactHarnessSummary(command, Number.POSITIVE_INFINITY);
    expect(preview).toContain("token=[redacted]");
    expect(preview).toContain("; rm -rf /workspace");
    expect(preview).not.toContain("private-value");
    expect(redactHarnessSummary("abcdef", 3)).toBe("abc");
    expect(() => redactHarnessSummary("value", 0)).toThrow("positive");
    expect(() => redactHarnessSummary("value", Number.NaN)).toThrow("positive");
  });

  it("redacts quoted JSON secret keys, escaped string values, and bearer tokens", () => {
    const input = JSON.stringify({
      authorization: "Bearer private-bearer",
      command:
        "curl -H 'Authorization: Bearer private-header' https://user:private-url@example.test",
      password: 'private-"password',
      token: "private-token",
    });
    const preview = redactHarnessSummary(input, Number.POSITIVE_INFINITY);
    expect(preview).toContain('token":');
    expect(preview).toContain("[redacted]");
    for (const secret of [
      "private-token",
      "private-password",
      "private-bearer",
      "private-header",
      "private-url",
    ]) {
      expect(preview).not.toContain(secret);
    }
    expect(preview).not.toContain("private-");
  });

  it("summarizes inputs without command values", () => {
    expect(summarizeHarnessInput({ command: "secret", token: "secret" })).toBe(
      "fields: command, token"
    );
    expect(summarizeHarnessInput("secret")).toBe("[string: 6 characters]");
  });
});
