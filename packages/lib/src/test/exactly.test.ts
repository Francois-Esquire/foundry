import { expect, it } from "vitest";

import type { Exactly } from "../exactly";

interface Shape {
  readonly count?: number;
  readonly id: string;
}

it("keeps a type that agrees and collapses one that does not", () => {
  const agrees: Exactly<{ id: string; count?: number }, Shape> = { id: "a" };
  // @ts-expect-error A missing required member collapses to never.
  const missing: Exactly<{ count?: number }, Shape> = { id: "a" };
  // @ts-expect-error An extra required member collapses to never.
  const extra: Exactly<{ id: string; owner: string }, Shape> = { id: "a" };
  // @ts-expect-error A changed member type collapses to never.
  const changed: Exactly<{ id: number }, Shape> = { id: "a" };
  // Documented limit: an optional member on one side only still agrees.
  const optionalExtra: Exactly<{ id: string; note?: string }, Shape> = {
    id: "a",
  };

  expect([agrees, missing, extra, changed, optionalExtra]).toHaveLength(5);
});
