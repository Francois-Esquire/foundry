import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { step, workflow } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { isLockedNode } from "~/lib/definition";
import { createLog } from "~/lib/log";
import { declared } from "../helpers/engine";

const ALREADY_REGISTERED = /already registered/;
const CHILD_AND_INPUT = /both a child and an input key/;
const UNDECLARED_CHILD = /"other" is not an input key \(declared: findings\)/;
const UNDECLARED_CHILD_TYPED = /"other" is not an input key/;
const NOT_A_NODE = /not a locked node/;
const EXPECTED_NODE = /expected a locked node/;
const WORKFLOW_CHILD = /child "a" is a workflow/;

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

  it("rejects a workflow as a child: only a run's root may be one", () => {
    const inner = workflow("inner", step().do(() => 1)({}));
    const parent = step()
      .input(z.object({ a: z.number() }))
      .do(({ input }) => input.a);
    expect(() => parent({ a: inner({}) })).toThrow(WORKFLOW_CHILD);
  });

  it("workflow accepts a tree, a function returning one, or the builder", async () => {
    const leaf = step().do(() => 1);
    const tree = leaf({});
    const fromTree = workflow("a", tree);
    const fromFn = workflow("b", () => leaf({}));
    const fromBuilder = workflow("c")
      .input(z.object({ task: z.string() }))
      .do(() => leaf({}));
    // A tree known up front is a setup that returns it.
    expect(
      await fromTree.setup({
        input: {},
        log: createLog(() => undefined),
        run: { id: "run" },
      })
    ).toBe(tree);
    expect(fromFn.setup).toBeDefined();
    expect(fromBuilder.setup).toBeDefined();
    expect(fromBuilder.input).toBeDefined();
    expect(() => workflow("d", {} as never)).toThrow(EXPECTED_NODE);
  });

  it("types a literal from the schema's input and checks children against it", () => {
    const implement = step()
      .input(z.object({ task: z.string() }))
      .output(z.string())
      .do(() => "branch");
    const review = step()
      .input(
        z.object({
          branch: z.string().optional(),
          target: z.string().default("."),
        })
      )
      .do(({ input }) => input.target);
    const count = step().do(() => 1);
    const publish = step()
      .input(z.object({ exitCode: z.number(), findings: z.string() }))
      .do(({ input }) => input);
    const coerce = step()
      .input(z.object({ n: z.string().transform(Number) }))
      .do(({ input }) => input.n);

    // Defaulted fields are optional; a child fills a key the literal then omits.
    review({});
    const chain = review({ branch: implement({}, { task: "t" }) });
    expect(chain.children.map(([key]) => key)).toEqual(["branch"]);
    // A transform's literal is its pre-image.
    coerce({}, { n: "2" });
    // Children are checked against the parent's keys by output type.
    const weekly = publish.parallel({
      exitCode: count({}),
      findings: review({}),
    });
    expect(weekly.mode).toBe("parallel");
    const named = workflow("typed-weekly", weekly);
    expect(named.name).toBe("typed-weekly");

    // @ts-expect-error a number-producing child for a string key
    publish.parallel({ exitCode: count({}), findings: count({}) });
    // @ts-expect-error a string-producing child for a number key
    publish({ exitCode: implement({}, { task: "t" }), findings: review({}) });
    expect(() =>
      // @ts-expect-error a key the parent's input does not declare
      publish({ exitCode: count({}), findings: review({}), other: count({}) })
    ).toThrow(UNDECLARED_CHILD_TYPED);
    // @ts-expect-error a required literal key is missing
    implement({}, {});
    // @ts-expect-error a transform takes its input type, not its output
    coerce({}, { n: 2 });
    expect(catalog.definitions.size).toBe(1);
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
    const [entry] = declared().entries();
    expect(entry).toMatchObject({
      description: "A typed step",
      kind: "step",
      name: "typed",
    });
    expect(entry?.input.fields).toEqual([
      { label: "N", name: "n", required: true, type: "number" },
    ]);
  });
});
