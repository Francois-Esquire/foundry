import { describe, expect, it } from "vitest";

import type { AuthorizationSubject } from "../authorization";
import type { GrantDocumentStorage } from "../authorization/document";
import { DocumentGrantRepository } from "../authorization/document";
import type { TestCapability } from "./helpers/authorization-support";
import {
  fsRead,
  preset,
  testAddressing,
  testCapabilitySchema,
  testSubjectSchema,
} from "./helpers/authorization-support";
import { grantRepositoryContract } from "./helpers/grant-repository-contract";

const addressing = testAddressing();
const ADDRESS = addressing.addressOf(preset("chat", 3), fsRead("/p"));

function memoryStorage(initial?: string): GrantDocumentStorage & {
  readonly text: () => string | undefined;
} {
  let stored = initial;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    text: () => stored,
    transact(apply) {
      const run = queue.then(() => {
        const { next, result } = apply(stored);
        if (next !== undefined) {
          stored = next;
        }
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

function repository(
  storage: GrantDocumentStorage,
  now: () => number = () => 1000
): DocumentGrantRepository<AuthorizationSubject, TestCapability> {
  return new DocumentGrantRepository({
    addressing,
    capability: testCapabilitySchema,
    format: "test-grants/1",
    now,
    storage,
    subject: testSubjectSchema,
  });
}

grantRepositoryContract("the document grant repository", (now) =>
  Promise.resolve(repository(memoryStorage(), now))
);

describe("the document grant repository's storage", () => {
  it("is handed the document as text, and keeps what each change leaves", async () => {
    const storage = memoryStorage();
    const issued = await repository(storage).issue({
      address: ADDRESS,
      capability: fsRead("/p"),
      lifetime: { kind: "persistent" },
      provenance: "human",
    });
    expect(JSON.parse(storage.text() ?? "")).toMatchObject({
      format: "test-grants/1",
      sequence: 1,
    });
    expect(await repository(storage).find(ADDRESS, 1000)).toEqual([issued]);
  });

  it("refuses a document that does not parse, without echoing it or replacing it", async () => {
    const storage = memoryStorage('{"secret-token-123');
    const refusal = await repository(storage)
      .find(ADDRESS, 1000)
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(refusal).toBeInstanceOf(Error);
    expect(String(refusal)).toContain("refusing authorization");
    expect(String(refusal)).not.toContain("secret-token-123");
    expect((refusal as Error).cause).toBeUndefined();
    expect(storage.text()).toBe('{"secret-token-123');
  });
});
