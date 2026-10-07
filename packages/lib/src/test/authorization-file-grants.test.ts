import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthorizationSubject } from "../config/authorization";
import { GrantClaimError } from "../config/authorization";
import { FileGrantRepository } from "../config/authorization/file";
import type { TestCapability } from "./helpers/authorization-support";
import {
  fsRead,
  preset,
  testAddressing,
  testCapabilitySchema,
  testSubjectSchema,
} from "./helpers/authorization-support";
import { grantRepositoryContract } from "./helpers/grant-repository-contract";

const FORMAT = "test-grants/1";
const addressing = testAddressing();
const ADDRESS = addressing.addressOf(preset("chat", 3), fsRead("/p"));

const directories: string[] = [];

async function freshPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lib-file-grants-"));
  directories.push(directory);
  return join(directory, "authority", "grants.json");
}

function repository(
  path: string,
  now: () => number = () => 1000,
  lockWaitMs?: number
): FileGrantRepository<AuthorizationSubject, TestCapability> {
  return new FileGrantRepository({
    addressing,
    capability: testCapabilitySchema,
    format: FORMAT,
    now,
    path,
    subject: testSubjectSchema,
    ...(lockWaitMs === undefined ? {} : { lockWaitMs }),
  });
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

grantRepositoryContract("the file grant repository", async (now) =>
  repository(await freshPath(), now)
);

describe("the file grant repository on disk", () => {
  let path: string;

  beforeEach(async () => {
    path = await freshPath();
  });

  const persistent = {
    address: ADDRESS,
    capability: fsRead("/p"),
    lifetime: { kind: "persistent" },
    provenance: "human",
  } as const;

  it("keeps grants and claims across instances, in a private file and nothing else", async () => {
    const issued = await repository(path).issue({
      ...persistent,
      lifetime: { kind: "once" },
    });
    const claim = await repository(path).claimOnce(issued.id, "call-1");

    expect(await repository(path).find(ADDRESS, 1000)).toEqual([]);
    await expect(
      repository(path).claimOnce(issued.id, "call-1")
    ).resolves.toEqual(claim);
    // biome-ignore lint/suspicious/noBitwiseOperators: Mask file type bits to check private POSIX permissions.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(path, ".."))).toEqual(["grants.json"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      format: FORMAT,
      sequence: 1,
    });
  });

  it("serializes concurrent work from distinct instances", async () => {
    const issued = await Promise.all(
      Array.from({ length: 8 }, () => repository(path).issue(persistent))
    );
    expect(new Set(issued.map((grant) => grant.id)).size).toBe(8);

    const once = await repository(path).issue({
      ...persistent,
      lifetime: { kind: "once" },
    });
    const claims = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        repository(path).claimOnce(once.id, `call-${String(index)}`)
      )
    );
    expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1
    );
  });

  it.each([
    ["invalid JSON", "{invalid"],
    [
      "another format",
      JSON.stringify({ format: "other/1", grants: [], sequence: 0 }),
    ],
    [
      "a sequence that skips",
      JSON.stringify({ format: FORMAT, grants: [], sequence: 1 }),
    ],
    [
      "an unknown key",
      JSON.stringify({ format: FORMAT, grants: [], secret: "x", sequence: 0 }),
    ],
  ])("fails closed on %s without replacing the file", async (_, contents) => {
    await repository(path).issue(persistent);
    await writeFile(path, contents);

    await expect(repository(path).find(ADDRESS, 1000)).rejects.toThrow(
      "refusing authorization"
    );
    await expect(repository(path).issue(persistent)).rejects.toThrow(
      "refusing authorization"
    );
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("does not echo file contents in its refusal", async () => {
    await repository(path).issue(persistent);
    await writeFile(path, '{"secret-token-value');
    const error = await repository(path)
      .find(ADDRESS, 1000)
      .catch((caught: unknown) => caught);
    expect(String(error)).not.toContain("secret-token-value");
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBeUndefined();
  });

  it("refuses an address that disagrees with its capability", async () => {
    const grant = await repository(path).issue(persistent);
    await writeFile(
      path,
      JSON.stringify({
        format: FORMAT,
        grants: [
          {
            grant: { ...grant, capability: fsRead("/elsewhere") },
            revoked: false,
          },
        ],
        sequence: 1,
      })
    );
    await expect(repository(path).find(ADDRESS, 1000)).rejects.toThrow(
      "refusing authorization"
    );
  });

  it("refuses a consumed grant edited back to live", async () => {
    const grant = await repository(path).issue({
      ...persistent,
      lifetime: { kind: "once" },
    });
    const claim = await repository(path).claimOnce(grant.id, "call-1");
    await writeFile(
      path,
      JSON.stringify({
        format: FORMAT,
        grants: [{ claim, grant: { ...grant, revision: 2 }, revoked: false }],
        sequence: 1,
      })
    );
    await expect(
      repository(path).claimOnce(grant.id, "call-2")
    ).rejects.toThrow("refusing authorization");
  });

  it("refuses to store a grant its schemas would not read back", async () => {
    await expect(
      repository(path).issue({
        ...persistent,
        capability: { kind: "fs.read", root: 7 } as unknown as TestCapability,
      })
    ).rejects.toThrow("nothing was stored");
    await expect(repository(path).find(ADDRESS, 1000)).resolves.toEqual([]);
  });

  it("reports an abandoned lock instead of stealing it", async () => {
    await repository(path).issue(persistent);
    await writeFile(`${path}.lock`, "");

    await expect(
      repository(path, () => 1000, 50).claimOnce("grant_1", "call")
    ).rejects.toThrow("remove the abandoned lock");
    expect(await stat(`${path}.lock`)).toBeDefined();

    await rm(`${path}.lock`);
    await expect(
      repository(path).claimOnce("grant_1", "call")
    ).resolves.toEqual({
      grantId: "grant_1",
      invocationId: "call",
      revision: 1,
    });
  });

  it("refuses a grant that was never issued here", async () => {
    await expect(
      repository(path).claimOnce("grant_1", "call")
    ).rejects.toBeInstanceOf(GrantClaimError);
  });
});
