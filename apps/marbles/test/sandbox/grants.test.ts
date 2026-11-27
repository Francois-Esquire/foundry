import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentPrincipal,
  agentPrincipalMatcher,
  capabilityToAccessRequest,
  capabilityToScope,
  HOST_APPROVER,
} from "@foundry/agents/authorization";
import { Authorization } from "@foundry/authorization";
import { SqliteAuthorizationStore } from "@foundry/authorization/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeDatabase, type MarblesDatabase } from "~/database/open";

let root: string;
let opened: MarblesDatabase;

function createAuth(scope = "ws"): Authorization {
  return new Authorization({
    store: new SqliteAuthorizationStore({ database: opened.database, scope }),
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "marbles-auth-"));
  opened = await initializeDatabase(join(root, "marbles.db"));
});

afterEach(() => {
  opened.close();
  rmSync(root, { force: true, recursive: true });
});

describe("SQLite-backed Authorization in Marbles", () => {
  it("persists grants across reopened stores and isolates scopes", async () => {
    const first = createAuth("ws-1");
    const cap = {
      kind: "tool.call" as const,
      source: "harness" as const,
      tool: "bash",
    };
    const grant = await first.grant({
      holder: agentPrincipalMatcher("coder"),
      issuer: HOST_APPROVER,
      requestedBy: agentPrincipal("coder"),
      scope: capabilityToScope(cap),
    });

    const reopened = createAuth("ws-1");
    expect(await reopened.getGrant(grant.id)).toMatchObject({
      id: grant.id,
      state: "active",
    });
    expect(
      await reopened.check(
        capabilityToAccessRequest({ agentId: "coder", capability: cap })
      )
    ).toMatchObject({ kind: "allow" });

    const otherScope = createAuth("ws-2");
    expect(await otherScope.getGrant(grant.id)).toBeNull();
  });

  it("persists pending grants and consumes one-shot grants atomically", async () => {
    const auth = createAuth();
    const cap = {
      kind: "tool.call" as const,
      source: "harness" as const,
      tool: "bash",
    };
    const request = capabilityToAccessRequest({
      agentId: "coder",
      capability: cap,
      invocationId: "call-1",
      sessionId: "sess-1",
    });

    const pending = await auth.authorize(request, "call-1");
    expect(pending.kind).toBe("pending");
    if (pending.kind !== "pending") {
      throw new Error("expected pending");
    }

    const reopened = createAuth();
    await reopened.approve(pending.grant.id, {
      approver: HOST_APPROVER,
      rootAuthority: true,
      usesRemaining: 1,
    });

    const permitted = await reopened.authorize(request, "call-1", {
      openPending: false,
    });
    expect(permitted.kind).toBe("permitted");
    if (permitted.kind === "permitted") {
      permitted.permit.release();
    }

    const second = await reopened.authorize(
      capabilityToAccessRequest({
        agentId: "coder",
        capability: cap,
        invocationId: "call-2",
        sessionId: "sess-1",
      }),
      "call-2",
      { openPending: false }
    );
    expect(second.kind).toBe("denied");
  });
});
