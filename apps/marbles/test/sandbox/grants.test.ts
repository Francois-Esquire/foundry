import { execFile } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  AgentSubject,
  Capability,
  GrantInput,
  GrantLifetime,
} from "@foundry/agents/authorization";
import {
  agentAddressing,
  agentSubject,
  createAgentAuthorizer,
} from "@foundry/agents/authorization";
import {
  GrantClaimError,
  GrantRevisionError,
} from "@foundry/lib/config/authorization";
import { afterEach, beforeEach, expect, it } from "vitest";
import { JsonAgentGrantRepository } from "~/lib/sandbox/grants";

let directory: string;
let path: string;
let now: number;
const subject = agentSubject("helper", 3);
const capability: Capability = { domain: "example.com", kind: "web.fetch" };
const address = agentAddressing.addressOf(subject, capability);
const execute = promisify(execFile);

function repository(): JsonAgentGrantRepository {
  return new JsonAgentGrantRepository(path, { now: () => now });
}

function input(
  lifetime: GrantLifetime = { kind: "persistent" }
): GrantInput<AgentSubject, Capability> {
  return { address, capability, lifetime, provenance: "human" };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-grants-"));
  path = join(directory, "authority", "grants.json");
  now = 100;
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

it("preserves grant metadata, ordering and unique ids through reopen", async () => {
  const issued = await repository().issue({
    ...input({ kind: "session", scopeId: "conversation-1" }),
    certificateId: "certificate-1",
    expiresAt: 200,
    provenance: "certificate",
  });
  now = 110;
  const second = await repository().issue(input());
  expect(await repository().find(address, now)).toEqual([issued, second]);
  expect(issued).toMatchObject({ issuedAt: 100, revision: 1 });
  expect(second).toMatchObject({ id: "grant_2", issuedAt: 110 });
  // biome-ignore lint/suspicious/noBitwiseOperators: Mask file type bits to check private POSIX permissions.
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(join(directory, "authority"))).toEqual(["grants.json"]);
});

it("enforces the original session scope after reopening through the agent authorizer", async () => {
  await repository().issue(
    input({ kind: "session", scopeId: "conversation-1" })
  );
  const authorizer = createAgentAuthorizer({
    grants: repository(),
    now: () => now,
  });
  const request = { capability, invocationId: "call-1", subject };
  expect(
    await authorizer.decide({ ...request, scopeId: "conversation-1" })
  ).toMatchObject({ kind: "allow", source: "grant" });
  expect(
    await authorizer.decide({ ...request, scopeId: "conversation-2" })
  ).toEqual({ kind: "requires-approval" });
  expect(await authorizer.decide(request)).toEqual({
    kind: "requires-approval",
  });
});

it("serializes concurrent issuances from distinct repository instances", async () => {
  const issued = await Promise.all(
    Array.from({ length: 12 }, () => repository().issue(input()))
  );
  expect(new Set(issued.map((grant) => grant.id)).size).toBe(12);
  expect(await repository().find(address, now)).toHaveLength(12);
});

it("allows exactly one concurrent invocation and replays that claim after restart and expiry", async () => {
  const grant = await repository().issue({
    ...input({ kind: "once" }),
    expiresAt: 200,
  });
  const claims = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) =>
      repository().claimOnce(grant.id, `invocation-${String(index)}`)
    )
  );
  const accepted = claims.filter((result) => result.status === "fulfilled");
  expect(accepted).toHaveLength(1);
  expect(claims.filter((result) => result.status === "rejected")).toHaveLength(
    11
  );
  const claim = accepted[0]?.value;
  expect(claim).toBeDefined();
  if (!claim) {
    throw new Error("Expected a winning claim");
  }
  now = 300;
  expect(await repository().find(address, now)).toEqual([]);
  expect(await repository().claimOnce(grant.id, claim.invocationId)).toEqual({
    ...claim,
    revision: 2,
  });
  await expect(
    repository().claimOnce(grant.id, "another-invocation")
  ).rejects.toBeInstanceOf(GrantClaimError);
  await expect(repository().revoke(grant.id, 1)).rejects.toBeInstanceOf(
    GrantRevisionError
  );
  await repository().revoke(grant.id, 2);
  expect(await repository().claimOnce(grant.id, claim.invocationId)).toEqual(
    claim
  );
});

it("serializes competing claims from separate host processes", async () => {
  const grant = await repository().issue(input({ kind: "once" }));
  const source = resolve(
    import.meta.dirname,
    "../../src/lib/sandbox/grants.ts"
  );
  const claim = (invocation: string) =>
    execute("bun", [
      "--eval",
      `
    import { JsonAgentGrantRepository } from ${JSON.stringify(source)};
    const claim = await new JsonAgentGrantRepository(${JSON.stringify(path)}).claimOnce(${JSON.stringify(grant.id)}, ${JSON.stringify(invocation)});
    process.stdout.write(JSON.stringify(claim));
  `,
    ]);
  const results = await Promise.allSettled([
    claim("process-1"),
    claim("process-2"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(1);
  const rejected = results.filter((result) => result.status === "rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({
    stderr: expect.stringContaining("already claimed by another invocation"),
  });
  expect(await repository().find(address, now)).toEqual([]);
});

it("keeps durable claims reusable and revocation revision-checked across restart", async () => {
  const grant = await repository().issue(input());
  expect(await repository().claimOnce(grant.id, "first")).toEqual({
    grantId: grant.id,
    invocationId: "first",
    revision: 1,
  });
  expect(await repository().claimOnce(grant.id, "second")).toEqual({
    grantId: grant.id,
    invocationId: "second",
    revision: 1,
  });
  await repository().revoke(grant.id, 1);
  expect(await repository().find(address, now)).toEqual([]);
  await expect(
    repository().claimOnce(grant.id, "first")
  ).rejects.toBeInstanceOf(GrantClaimError);
  await expect(repository().revoke(grant.id, 1)).rejects.toMatchObject({
    actual: 2,
    expected: 1,
  });
  await repository().revoke(grant.id, 2);
  await repository().revoke("never-issued", 99);
  expect((await repository().issue(input())).id).toBe("grant_2");
});

it("rechecks expiry at the effect boundary and treats its exact deadline as expired", async () => {
  const grant = await repository().issue({
    ...input({ kind: "once" }),
    expiresAt: 120,
  });
  expect(await repository().find(address, 119)).toEqual([grant]);
  now = 120;
  expect(await repository().find(address, now)).toEqual([]);
  await expect(repository().claimOnce(grant.id, "late")).rejects.toThrow(
    "revoked or expired"
  );
  await expect(repository().claimOnce("missing", "late")).rejects.toThrow(
    "does not exist"
  );
});

it("isolates authority by preset generation and capability constraints", async () => {
  const read: Capability = {
    kind: "fs.read",
    projectId: "project",
    root: "/workspace",
  };
  const scoped = agentAddressing.addressOf(subject, read);
  const grant = await repository().issue({
    ...input(),
    address: scoped,
    capability: read,
  });
  expect(await repository().find(scoped, now)).toEqual([grant]);
  expect(
    await repository().find(
      agentAddressing.addressOf(agentSubject("helper", 4), read),
      now
    )
  ).toEqual([]);
  expect(
    await repository().find(
      agentAddressing.addressOf(subject, { ...read, root: "/other" }),
      now
    )
  ).toEqual([]);
});

it.each<Capability>([
  { domain: "example.com", kind: "web.fetch" },
  { kind: "mcp.tool", serverId: "server", tool: "read" },
  { kind: "fs.read", projectId: "project", root: "/workspace" },
  {
    command: { id: "update", version: 2 },
    domain: "issues",
    effect: "write",
    kind: "domain.command",
    target: { projectId: "project", scope: "issue" },
  },
  { kind: "tool.call", source: "harness", tool: "shell" },
])(
  "retains the exact $kind payload and address after reopen",
  async (value) => {
    const scoped = agentAddressing.addressOf(subject, value);
    const grant = await repository().issue({
      ...input(),
      address: scoped,
      capability: value,
    });
    expect(await repository().find(scoped, now)).toEqual([grant]);
  }
);

it.each([
  "{invalid json",
  JSON.stringify({ format: "unknown", grants: [], sequence: 0 }),
  JSON.stringify({ format: "agent-grants/1", grants: [], sequence: 1 }),
  JSON.stringify({
    credentials: "raw-secret",
    format: "agent-grants/1",
    grants: [],
    sequence: 0,
  }),
])(
  "fails closed for corrupt saved data without replacing it",
  async (contents) => {
    await repository().issue(input());
    await writeFile(path, contents);
    await expect(repository().find(address, now)).rejects.toThrow(
      "refusing authorization"
    );
    await expect(repository().issue(input())).rejects.toThrow(
      "refusing authorization"
    );
    await expect(repository().claimOnce("grant_1", "call")).rejects.toThrow(
      "refusing authorization"
    );
    await expect(repository().revoke("grant_1")).rejects.toThrow(
      "refusing authorization"
    );
    expect(await readFile(path, "utf8")).toBe(contents);
    expect(await readdir(join(directory, "authority"))).toEqual([
      "grants.json",
    ]);
  }
);

it("rejects an address inconsistent with the saved capability", async () => {
  const grant = await repository().issue(input());
  const inconsistent = {
    ...grant,
    capability: { domain: "attacker.example", kind: "web.fetch" },
  };
  await writeFile(
    path,
    JSON.stringify({
      format: "agent-grants/1",
      grants: [{ grant: inconsistent, revoked: false }],
      sequence: 1,
    })
  );
  await expect(repository().find(address, now)).rejects.toThrow(
    "refusing authorization"
  );
});

it("rejects a consumed grant corrupted back to live authority", async () => {
  const grant = await repository().issue(input({ kind: "once" }));
  const claim = await repository().claimOnce(grant.id, "first");
  await writeFile(
    path,
    JSON.stringify({
      format: "agent-grants/1",
      grants: [{ claim, grant: { ...grant, revision: 2 }, revoked: false }],
      sequence: 1,
    })
  );
  await expect(repository().find(address, now)).rejects.toThrow(
    "refusing authorization"
  );
});

it("fails closed on an abandoned writer lock without deleting it", async () => {
  await repository().issue(input());
  await writeFile(`${path}.lock`, "", { mode: 0o600 });
  await expect(repository().claimOnce("grant_1", "call")).rejects.toThrow(
    "remove the abandoned lock"
  );
  expect(await stat(`${path}.lock`)).toBeDefined();
  await rm(`${path}.lock`);
  expect(await repository().find(address, now)).toHaveLength(1);
}, 10_000);
