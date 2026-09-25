import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { step, workflow } from "~/lib2/builder";
import { catalog } from "~/lib2/catalog";
import { isLockedNode } from "~/lib2/definition";

const ALREADY_REGISTERED = /already registered/;
const CHILD_AND_INPUT = /both a child and an input key/;
const UNDECLARED_CHILD = /"other" is not an input key \(declared: findings\)/;
const NOT_A_NODE = /not a locked node/;
const EXPECTED_NODE = /expected a locked node/;

afterEach(() => {
  catalog.reset();
});

describe("definitions and locking", () => {
  it("names register in the catalog; anonymous definitions do not", () => {
    step("review").do(() => "ok");
    step().do(() => "internal");
    workflow("weekly", step().do(() => 1)({}));
    expect([...catalog.definitions.keys()]).toEqual(["review", "weekly"]);
  });

  it("refuses a repeated name across steps and workflows", () => {
    step("x").do(() => null);
    expect(() => workflow("x", step().do(() => 1)({}))).toThrow(
      ALREADY_REGISTERED
    );
  });

  it("locks into a node with children and literal input", () => {
    const leaf = step()
      .input(z.object({ target: z.string() }))
      .do(({ input }) => input.target);
    const parent = step()
      .input(z.object({ findings: z.string(), flag: z.boolean() }))
      .do(({ input }) => input);
    const node = parent.parallel(
      { findings: leaf({}, { target: "." }) },
      { flag: true }
    );
    expect(isLockedNode(node)).toBe(true);
    expect(node.mode).toBe("parallel");
    expect(node.children.map(([key]) => key)).toEqual(["findings"]);
    expect(node.literal).toEqual({ flag: true });
    expect(node.children[0]?.[1].literal).toEqual({ target: "." });
  });

  it("one definition locks many times into distinct nodes", () => {
    const leaf = step().do(() => 1);
    const first = leaf({});
    const second = leaf.series({});
    expect(first).not.toBe(second);
    expect(first.definition).toBe(second.definition);
  });

  it("rejects a key that is both a child and a literal", () => {
    const leaf = step().do(() => 1);
    const parent = step().do(() => 1);
    expect(() =>
      (parent as unknown as (c: object, i: object) => unknown)(
        { a: leaf({}) },
        { a: 2 }
      )
    ).toThrow(CHILD_AND_INPUT);
  });

  it("rejects a child key the input schema does not declare", () => {
    const leaf = step().do(() => 1);
    const parent = step("publish")
      .input(z.object({ findings: z.string() }))
      .do(({ input }) => input.findings);
    expect(() =>
      (parent as unknown as (c: object) => unknown)({ other: leaf({}) })
    ).toThrow(UNDECLARED_CHILD);
  });

  it("rejects a child that is not a locked node", () => {
    const leaf = step().do(() => 1);
    const parent = step().do(() => 1);
    expect(() =>
      (parent as unknown as (c: object) => unknown)({ a: leaf })
    ).toThrow(NOT_A_NODE);
  });

  it("workflow accepts a tree, a function returning one, or the builder", () => {
    const leaf = step().do(() => 1);
    const fromTree = workflow("a", leaf({}));
    const fromFn = workflow("b", () => leaf({}));
    const fromBuilder = workflow("c")
      .input(z.object({ task: z.string() }))
      .do(() => leaf({}));
    expect(fromTree.tree).toBeDefined();
    expect(fromFn.setup).toBeDefined();
    expect(fromBuilder.setup).toBeDefined();
    expect(fromBuilder.input).toBeDefined();
    expect(() => workflow("d", {} as never)).toThrow(EXPECTED_NODE);
  });

  it("carries describe, input, and output through the builder", () => {
    const def = step("typed")
      .describe("A typed step")
      .input(z.object({ n: z.number() }))
      .output(z.string())
      .do(({ input }) => String(input.n));
    expect(def.description).toBe("A typed step");
    expect(def.input).toBeDefined();
    expect(def.output).toBeDefined();
    const [entry] = catalog.entries();
    expect(entry).toMatchObject({
      description: "A typed step",
      kind: "step",
      name: "typed",
    });
    expect(entry?.fields).toEqual([
      { label: "N", name: "n", required: true, type: "number" },
    ]);
  });
});
