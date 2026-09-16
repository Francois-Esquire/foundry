/**
 * StepContext public contract.
 *
 * An execute body receives `(input, ctx)` where production `StepContext`
 * exposes the current Step, typed context, composition helpers, snapshot
 * values, channels, and suspension controls. These tests pin that contract so
 * an execute body can:
 *
 *   - read its typed services (`agent`, db handle, etc.) without closure
 *   - fork a dynamic child that *inherits the typed services type*
 *   - drive children via the composer's invoke / parallel / race / branch /
 *     sequence (currently undocumented on the user-facing surface)
 *   - read the current snapshot (results, step statuses, workflow tree)
 *     and subscribe to state changes — "get results when they're available"
 *   - publish chunks / events / suspend, all delegated to the step
 *
 * Deferred scheduling and eager await-result semantics are explicit package
 * non-goals; they are not represented as skipped executable tests.
 */

import { describe, expect, it } from "vitest";

import type { BaseContext } from "../executable";
import type { StepContext, StepSpec } from "../step";

import { Step } from "../step";

// ────────────────────────────────────────────────────────────────────────────
// Test plumbing keeps literal output inference while using the production
// StepContext type directly.
// ────────────────────────────────────────────────────────────────────────────

type CtxExecute<I, O, X extends BaseContext> = (
  input: I,
  ctx: StepContext<I, O, X>
) => Promise<O>;

interface CtxStepSpec<I, O, X extends BaseContext>
  extends Omit<StepSpec<I, O, X>, "execute"> {
  readonly execute: CtxExecute<I, O, X>;
}

function asSpec<I, O, X extends BaseContext = BaseContext>(
  spec: CtxStepSpec<I, O, X>
): StepSpec<I, O, X> {
  return spec;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. ctx — shape and identity
// ════════════════════════════════════════════════════════════════════════════

describe("ctx — shape and identity", () => {
  it("execute receives ctx as the 3rd argument", async () => {
    let received: unknown = "<<NOT-CALLED>>";
    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        received = ctx;
        return "ok";
      },
      input: undefined,
      name: "ctx-3rd-arg",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(received).toBeDefined();
    expect(received).not.toBeNull();
  });

  it("ctx.step === the running Step instance", async () => {
    const captured: { ctxStep?: unknown; outerStep?: Step } = {};
    const spec = asSpec<unknown, unknown>({
      execute: async (_input, ctx) => {
        captured.ctxStep = ctx.step;
        return "ok";
      },
      input: undefined,
      name: "ctx-step-identity",
    });

    const step = await Step.make(spec);
    captured.outerStep = step;
    await step.run();

    expect(captured.ctxStep).toBe(captured.outerStep);
  });

  it("ctx.signal === ctx.step.signal (same AbortSignal reference)", async () => {
    const captured: { ctxSignal?: unknown; stepSignal?: AbortSignal } = {};
    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        captured.ctxSignal = ctx.signal;
        captured.stepSignal = ctx.step.signal;
        return "ok";
      },
      input: undefined,
      name: "ctx-signal",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured.ctxSignal).toBeInstanceOf(AbortSignal);
    expect(captured.ctxSignal).toBe(captured.stepSignal);
  });

  it("ctx.path === ctx.step.path (same readonly array)", async () => {
    const captured: { ctxPath?: unknown; stepPath?: readonly string[] } = {};
    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        captured.ctxPath = ctx.path;
        captured.stepPath = ctx.step.path;
        return "ok";
      },
      input: undefined,
      name: "ctx-path",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured.ctxPath).toEqual(["ctx-path"]);
    expect(captured.ctxPath).toBe(captured.stepPath);
  });

  it("ctx.children === step.children (declared children, same reference)", async () => {
    const captured: {
      ctxChildren?: unknown;
    } = {};
    const spec = asSpec<void, "ok">({
      children: [
        {
          execute: async () => "leaf-out",
          input: undefined,
          name: "leaf",
        },
      ],
      execute: async (_input, ctx) => {
        captured.ctxChildren = ctx.children;
        return "ok";
      },
      input: undefined,
      name: "ctx-children",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(Array.isArray(captured.ctxChildren)).toBe(true);
    expect(captured.ctxChildren).toBe(step.children);
    expect((captured.ctxChildren as readonly Step[]).length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. ctx — typed context spread (Step-owned, inherited via composition)
// ════════════════════════════════════════════════════════════════════════════
//
// Step owns the typed context X (today via `step.context: X`, set at
// construction through `spec.seed`). Workflow inherits this because
// Workflow IS a Step wrapper. Every child created through composition
// (`executable.fork` chain) carries the same X by reference — that's the
// headline value-prop: set the agent / db / tenant once at the root, every
// step in the tree sees it via `ctx.<name>` with no re-injection.
//
// X is spread onto ctx directly: `ctx.agent`, not `ctx.services.agent`.

// Synthetic agent — class instance so we can verify reference identity
// (instanceof, ===) survives the seed → context → ctx pipeline.
class FakeAgent {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  describe(): string {
    return `agent:${this.id}`;
  }
}

interface AgentContext extends BaseContext {
  readonly agent: FakeAgent;
  readonly tenant: string;
}

describe("ctx — typed context spread (X on ctx directly)", () => {
  it("ctx carries the X fields set at the root step's spec.seed", async () => {
    const agent = new FakeAgent("a-1");
    const captured: { agent?: unknown; tenant?: unknown; name?: unknown } = {};
    const spec = asSpec<void, "ok", AgentContext>({
      execute: async (_input, ctx) => {
        captured.agent = ctx.agent;
        captured.tenant = ctx.tenant;
        captured.name = ctx.name;
        return "ok";
      },
      input: undefined,
      name: "ctx-spread",
      seed: { agent, tenant: "acme" },
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured.agent).toBe(agent);
    expect(captured.tenant).toBe("acme");
    expect(captured.name).toBe("ctx-spread");
  });

  it("ctx.<X> is stable across retry attempts within the same run", async () => {
    const agent = new FakeAgent("a-2");
    const seen: unknown[] = [];
    let attempts = 0;
    const spec = asSpec<void, "ok", AgentContext>({
      config: {
        retry: { backoff: { delay: "1ms", kind: "fixed" }, maxAttempts: 3 },
      },
      execute: async (_input, ctx) => {
        seen.push(ctx.agent);
        attempts++;
        if (attempts < 3) {
          throw new Error(`flake ${String(attempts)}`);
        }
        return "ok";
      },
      input: undefined,
      name: "ctx-attempts",
      seed: { agent, tenant: "acme" },
    });

    const step = await Step.make(spec);
    await step.run();

    expect(attempts).toBe(3);
    expect(seen.length).toBe(3);
    expect(seen[0]).toBeDefined();
    for (const ref of seen) {
      expect(ref).toBe(agent);
    }
  });

  it("a declared child sees the parent's ctx.<X> via composition (no re-injection)", async () => {
    const agent = new FakeAgent("a-3");
    const captured: {
      parentAgent?: unknown;
      childAgent?: unknown;
      childTenant?: unknown;
    } = {};
    const spec = asSpec<void, "ok", AgentContext>({
      children: [
        asSpec<void, "ok", AgentContext>({
          execute: async (_input, ctx) => {
            captured.childAgent = ctx.agent;
            captured.childTenant = ctx.tenant;
            return "ok";
          },
          input: undefined,
          name: "ctx-child",
        }),
      ] as unknown as readonly StepSpec[],
      execute: async (_input, ctx) => {
        captured.parentAgent = ctx.agent;
        await ctx.children[0]?.run();
        return "ok";
      },
      input: undefined,
      name: "ctx-parent",
      seed: { agent, tenant: "acme" },
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured.parentAgent).toBe(agent);
    expect(captured.childAgent).toBe(agent);
    expect(captured.childTenant).toBe("acme");
  });

  it("ctx.name reflects the current frame's name, not the root's", async () => {
    const agent = new FakeAgent("a-4");
    const captured: { parentName?: string; childName?: string } = {};
    const spec = asSpec<void, "ok", AgentContext>({
      children: [
        asSpec<void, "ok", AgentContext>({
          execute: async (_input, ctx) => {
            captured.childName = ctx.name;
            return "ok";
          },
          input: undefined,
          name: "child-frame",
        }),
      ] as unknown as readonly StepSpec[],
      execute: async (_input, ctx) => {
        captured.parentName = ctx.name;
        await ctx.children[0]?.run();
        return "ok";
      },
      input: undefined,
      name: "root-frame",
      seed: { agent, tenant: "acme" },
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured.parentName).toBe("root-frame");
    expect(captured.childName).toBe("child-frame");
  });

  it("a class instance (agent) survives ctx with === identity and instanceof", async () => {
    const agent = new FakeAgent("a-5");
    const captured: { agent?: unknown; described?: string } = {};
    const spec = asSpec<void, "ok", AgentContext>({
      execute: async (_input, ctx) => {
        captured.agent = ctx.agent;
        captured.described = ctx.agent.describe();
        return "ok";
      },
      input: undefined,
      name: "ctx-instanceof",
      seed: { agent, tenant: "acme" },
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured.agent).toBeInstanceOf(FakeAgent);
    expect(captured.agent).toBe(agent);
    expect(captured.described).toBe("agent:a-5");
  });

  it("ctx.<X> is the same reference at every depth (no clone, no rebox)", async () => {
    const agent = new FakeAgent("a-6");
    const seen: unknown[] = [];

    function leaf(name: string): CtxStepSpec<void, "ok", AgentContext> {
      return {
        execute: async (_input, ctx) => {
          seen.push(ctx.agent);
          return "ok";
        },
        input: undefined,
        name,
      };
    }

    const spec = asSpec<void, "ok", AgentContext>({
      children: [
        asSpec<void, "ok", AgentContext>({
          children: [
            asSpec<void, "ok", AgentContext>(leaf("depth-2")),
          ] as unknown as readonly StepSpec[],
          execute: async (_input, ctx) => {
            seen.push(ctx.agent);
            await ctx.children[0]?.run();
            return "ok";
          },
          input: undefined,
          name: "depth-1",
        }),
      ] as unknown as readonly StepSpec[],
      execute: async (_input, ctx) => {
        seen.push(ctx.agent);
        await ctx.children[0]?.run();
        return "ok";
      },
      input: undefined,
      name: "depth-0",
      seed: { agent, tenant: "acme" },
    });

    const step = await Step.make(spec);
    await step.run();

    expect(seen.length).toBe(3);
    for (const ref of seen) {
      expect(ref).toBe(agent);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. step.run(input, ctx?) — the optional pass-through extension point
// ════════════════════════════════════════════════════════════════════════════

describe("step.run(input, ctx?) — pass-through extension", () => {
  it("step.run(input) without ctx — body sees only the inherited X", async () => {
    const agent = new FakeAgent("inv-1");
    const captured: { agent?: unknown; tenant?: unknown } = {};
    const spec = asSpec<void, "ok", AgentContext>({
      execute: async (_input, ctx) => {
        captured.agent = ctx.agent;
        captured.tenant = ctx.tenant;
        return "ok";
      },
      input: undefined,
      name: "inv-no-extra",
      seed: { agent, tenant: "acme" },
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured.agent).toBe(agent);
    expect(captured.tenant).toBe("acme");
  });

  it("step.run(input, { extra }) — body sees inherited X PLUS the extra fields", async () => {
    const agent = new FakeAgent("inv-2");
    const captured: { agent?: unknown; correlationId?: unknown } = {};
    const spec = asSpec<void, "ok", AgentContext>({
      execute: async (_input, ctx) => {
        captured.agent = ctx.agent;
        captured.correlationId = (
          ctx as unknown as { correlationId?: string }
        ).correlationId;
        return "ok";
      },
      input: undefined,
      name: "inv-extra",
      seed: { agent, tenant: "acme" },
    });

    const step = await Step.make(spec);
    await (
      step as unknown as {
        run: (input?: unknown, ctx?: object) => Promise<unknown>;
      }
    ).run(undefined, { correlationId: "corr-99" });

    expect(captured.agent).toBe(agent);
    expect(captured.correlationId).toBe("corr-99");
  });

  it("step.run(input, { agentOverride }) — explicit X-field overrides the inherited", async () => {
    const seedAgent = new FakeAgent("inv-3-seed");
    const overrideAgent = new FakeAgent("inv-3-override");
    const captured: { agent?: unknown } = {};
    const spec = asSpec<void, "ok", AgentContext>({
      execute: async (_input, ctx) => {
        captured.agent = ctx.agent;
        return "ok";
      },
      input: undefined,
      name: "inv-override",
      seed: { agent: seedAgent, tenant: "acme" },
    });

    const step = await Step.make(spec);
    await (
      step as unknown as {
        run: (input?: unknown, ctx?: object) => Promise<unknown>;
      }
    ).run(undefined, { agent: overrideAgent });

    expect(captured.agent).toBe(overrideAgent);
    expect(captured.agent).not.toBe(seedAgent);
  });

  it("step.invoke ctx-extension does NOT mutate the step's inherited context (step.context unchanged)", async () => {
    const seedAgent = new FakeAgent("inv-4-seed");
    const overrideAgent = new FakeAgent("inv-4-override");
    const captured: { bodyAgent?: unknown } = {};
    const spec = asSpec<void, "ok", AgentContext>({
      execute: async (_input, ctx) => {
        captured.bodyAgent = ctx.agent;
        return "ok";
      },
      input: undefined,
      name: "inv-isolation",
      seed: { agent: seedAgent, tenant: "acme" },
    });

    const step = await Step.make(spec);
    const beforeAgent = step.context.agent;
    await step.run(undefined, { agent: overrideAgent });
    const afterAgent = step.context.agent;
    expect(beforeAgent).toBe(seedAgent);
    expect(afterAgent).toBe(seedAgent);
    expect(captured.bodyAgent).toBe(overrideAgent);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. ctx.fork — typed X propagation
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.fork — dynamic child creation with typed X", () => {
  it("ctx.fork(spec) does NOT execute the child during the body (deferred to the cascade)", async () => {
    const captured: {
      fork?: unknown;
      bodyTimeRanBody: boolean;
      bodyTimeChildStatus?: string;
    } = {
      bodyTimeRanBody: false,
    };
    const childSpec = asSpec<void, "child-out">({
      execute: async () => {
        captured.bodyTimeRanBody = true;
        return "child-out";
      },
      input: undefined,
      name: "fork-child",
    });
    let spy = false;
    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        captured.fork = ctx.fork(childSpec);
        spy = captured.bodyTimeRanBody;
        return "ok";
      },
      input: undefined,
      name: "fork-parent",
    });

    const step = await Step.make(spec);
    await step.run();
    expect(captured.fork).toBeInstanceOf(Step);
    expect(spy).toBe(false);
    expect(captured.bodyTimeRanBody).toBe(true);
    const stepsState = step.steps;
    expect(stepsState["fork-parent.fork-child"]?.status).toBe("complete");
  });

  it("the forked child sees the parent's ctx.<X> via composition (no re-injection)", async () => {
    const agent = new FakeAgent("fork-1");
    const captured: { childAgent?: unknown; childTenant?: unknown } = {};
    const childSpec = asSpec<void, "ok", AgentContext>({
      execute: async (_input, ctx) => {
        captured.childAgent = ctx.agent;
        captured.childTenant = ctx.tenant;
        return "ok";
      },
      input: undefined,
      name: "fork-child",
    });
    const spec = asSpec<void, "ok", AgentContext>({
      execute: async (_input, ctx) => {
        const child = ctx.fork(childSpec);
        await child.run();
        return "ok";
      },
      input: undefined,
      name: "fork-parent",
      seed: { agent, tenant: "acme" },
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured.childAgent).toBe(agent);
    expect(captured.childTenant).toBe("acme");
  });

  it("the forked child shares the parent's snapshot and channels references", async () => {
    const captured: {
      parentSnapshot?: unknown;
      parentChannels?: unknown;
      childSnapshot?: unknown;
      childChannels?: unknown;
    } = {};
    const childSpec = asSpec<void, "ok">({
      execute: async () => "ok",
      input: undefined,
      name: "fork-child",
    });
    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        captured.parentSnapshot = ctx.step.snapshot;
        captured.parentChannels = ctx.step.channels;
        const child = ctx.fork(childSpec);
        captured.childSnapshot = child.snapshot;
        captured.childChannels = child.channels;
        return "ok";
      },
      input: undefined,
      name: "fork-parent",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured.parentSnapshot).toBeDefined();
    expect(captured.childSnapshot).toBeDefined();
    expect(captured.childSnapshot).toBe(captured.parentSnapshot);
    expect(captured.childChannels).toBe(captured.parentChannels);
  });

  it("the forked child's lifecycle events fold into the parent's snapshot under the namespaced key", async () => {
    const childSpec = asSpec<void, "child-out">({
      execute: async () => "child-out",
      input: undefined,
      name: "fork-child",
    });
    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        const child = ctx.fork(childSpec);
        await child.run();
        return "ok";
      },
      input: undefined,
      name: "fork-parent",
    });

    const step = await Step.make(spec);
    await step.run();
    const steps = step.steps;
    expect(Object.keys(steps).sort()).toEqual([
      "fork-parent",
      "fork-parent.fork-child",
    ]);
    expect(steps["fork-parent.fork-child"]?.status).toBe("complete");
    expect(steps["fork-parent.fork-child"]?.output).toBe("child-out");
  });

  it("a declared child (spec.children) shares the parent's snapshot and channels references", async () => {
    const spec = asSpec<void, "ok">({
      children: [
        {
          execute: async () => "ok",
          input: undefined,
          name: "declared-child",
        },
      ],
      execute: async (_input, ctx) => {
        await ctx.children[0]?.run();
        return "ok";
      },
      input: undefined,
      name: "declared-parent",
    });
    const step = await Step.make(spec);
    await step.run();
    const child = step.children[0];
    expect(child).toBeDefined();
    expect(child?.snapshot).toBe(step.snapshot);
    expect(child?.channels).toBe(step.channels);
    // And declared-child events fold into parent's snapshot under namespaced key.
    const steps = step.steps;
    expect(Object.keys(steps).sort()).toEqual([
      "declared-parent",
      "declared-parent.declared-child",
    ]);
    expect(steps["declared-parent.declared-child"]?.status).toBe("complete");
    expect(steps["declared-parent.declared-child"]?.output).toBe("ok");
  });

  it("ctx.fork shares the parent's abort substrate (parent.abort cascades to dynamic child)", async () => {
    let capturedChild: Step | undefined;
    const childSpec = asSpec<unknown, unknown>({
      execute: async () => "ok",
      input: undefined,
      name: "fork-child",
    });
    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        capturedChild = ctx.fork(childSpec);
        return "ok";
      },
      input: undefined,
      name: "fork-parent",
    });

    const step = await Step.make(spec);
    await step.run();
    expect(capturedChild?.aborted).toBe(false);
    step.abort("test-cascade");
    expect(capturedChild?.aborted).toBe(true);
  });

  it("ctx.fork(spec) APPENDS to step.children (no separate dynamic registry)", async () => {
    const captured: { dyn?: unknown } = {};
    const childSpec = asSpec<void, "ok">({
      execute: async () => "ok",
      input: undefined,
      name: "fork-child",
    });
    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        captured.dyn = ctx.fork(childSpec);
        ctx.fork({ ...childSpec, name: "fork-child-2" });
        return "ok";
      },
      input: undefined,
      name: "fork-parent",
    });

    const step = await Step.make(spec);
    await step.run();
    expect(captured.dyn).toBeInstanceOf(Step);
    expect(step.children.length).toBe(2);
    expect(step.children.map((c) => c.name)).toEqual([
      "fork-child",
      "fork-child-2",
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (Removed) ctx.spawn
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// 5. ctx.composer — orchestration primitives surfaced
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// 6. ctx.snapshot reads — current state
// ════════════════════════════════════════════════════════════════════════════

describe("ctx — current snapshot reads", () => {
  it("ctx.steps yields the current step records map", async () => {
    let capturedSteps: unknown = "<<NOT-SET>>";
    const spec = asSpec<void, "ok">({
      children: [
        {
          execute: async () => "leaf-out",
          input: undefined,
          name: "leaf",
        },
      ],
      execute: async (_input, ctx) => {
        await ctx.children[0]?.run();
        capturedSteps = await ctx.steps;
        return "ok";
      },
      input: undefined,
      name: "snap-steps",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(capturedSteps).toMatchObject({
      "snap-steps.leaf": { output: "leaf-out", status: "complete" },
    });
  });

  it("ctx.results includes outputs from sibling steps that have already completed", async () => {
    let capturedResults: unknown = "<<NOT-SET>>";
    const spec = asSpec<void, "ok">({
      children: [
        asSpec<unknown, unknown>({
          execute: async () => 11,
          input: undefined,
          name: "first",
        }),
        asSpec<unknown, unknown>({
          execute: async (_input, ctx) => {
            capturedResults = await ctx.results;
            return 22;
          },
          input: undefined,
          name: "second",
        }),
      ],
      execute: async (_input, ctx) => {
        await ctx.children[0]?.run();
        await ctx.children[1]?.run();
        return "ok";
      },
      input: undefined,
      name: "snap-results",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(capturedResults).toMatchObject({
      "snap-results.first": 11,
    });
  });

  it("ctx.steps includes the current step's own record with status='running'", async () => {
    let capturedSelf: unknown = "<<NOT-SET>>";
    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        const steps = await ctx.steps;
        capturedSelf = steps["snap-self"];
        return "ok";
      },
      input: undefined,
      name: "snap-self",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(capturedSelf).toMatchObject({ status: "running" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. ctx — path-relative helpers
// ════════════════════════════════════════════════════════════════════════════

describe("ctx — path-relative helpers", () => {
  it("ctx.resultOf(name) returns the output of a sibling under this step's namespace", async () => {
    let captured: unknown = "<<NOT-SET>>";
    const spec = asSpec<void, "ok">({
      children: [
        asSpec<unknown, unknown>({
          execute: async () => "first-out",
          input: undefined,
          name: "first",
        }),
        asSpec<unknown, unknown>({
          execute: async (_input, ctx) => {
            captured = ctx.resultOf("first");
            return "second-out";
          },
          input: undefined,
          name: "second",
        }),
      ],
      execute: async (_input, ctx) => {
        await ctx.children[0]?.run();
        await ctx.children[1]?.run();
        return "ok";
      },
      input: undefined,
      name: "helpers-rel",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured).toBe("first-out");
  });

  it("ctx.resultOf(name) returns undefined when the named child has not completed yet", async () => {
    const captured: { peek?: unknown; ctxAvailable?: boolean } = {};
    const spec = asSpec<void, "ok">({
      children: [
        asSpec<unknown, unknown>({
          execute: async (_input, ctx) => {
            captured.ctxAvailable = (ctx as unknown) !== undefined;
            captured.peek = ctx.resultOf("second");
            return "first-out";
          },
          input: undefined,
          name: "first",
        }),
        asSpec<unknown, unknown>({
          execute: async () => "second-out",
          input: undefined,
          name: "second",
        }),
      ],
      execute: async (_input, ctx) => {
        await ctx.children[0]?.run();
        await ctx.children[1]?.run();
        return "ok";
      },
      input: undefined,
      name: "helpers-not-yet",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured.ctxAvailable).toBe(true);
    expect(captured.peek).toBeUndefined();
  });

  it("ctx.statusOf(name) returns the StepStatus of a sibling step", async () => {
    let captured: unknown = "<<NOT-SET>>";
    const spec = asSpec<void, "ok">({
      children: [
        asSpec<unknown, unknown>({
          execute: async () => "ok",
          input: undefined,
          name: "first",
        }),
        asSpec<unknown, unknown>({
          execute: async (_input, ctx) => {
            captured = ctx.statusOf("first");
            return "ok";
          },
          input: undefined,
          name: "second",
        }),
      ],
      execute: async (_input, ctx) => {
        await ctx.children[0]?.run();
        await ctx.children[1]?.run();
        return "ok";
      },
      input: undefined,
      name: "helpers-status",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. ctx — channel write delegation
// ════════════════════════════════════════════════════════════════════════════

describe("ctx — channel write delegation", () => {
  it("ctx.write(text) writes a text chunk tagged with this step's name", async () => {
    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        ctx.write("hello");
        ctx.write("world");
        return "ok";
      },
      input: undefined,
      name: "publish-text",
    });

    const step = await Step.make(spec);
    const reader = step.stream.getReader();
    await step.run();
    const collected: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      collected.push(value);
    }
    reader.releaseLock();
    expect(collected).toEqual([
      { kind: "text", text: "hello" },
      { kind: "text", text: "world" },
    ]);
  });

  it("ctx.emit and ctx.write expose function-typed delegates", async () => {
    const captured: { emitType?: string; writeType?: string } = {};
    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        captured.emitType = typeof ctx.emit;
        captured.writeType = typeof ctx.write;
        ctx.emit("did-thing", { ok: true });
        return "ok";
      },
      input: undefined,
      name: "delegate-fns",
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured.emitType).toBe("function");
    expect(captured.writeType).toBe("function");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. ctx.suspend — Promise sugar over the Effect-typed primitive
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.suspend — Promise-flavored suspend", () => {
  it("parent.resolve(name, value) is visible to a declared child's ctx.suspend(name) on the next attempt", async () => {
    let attempts = 0;
    const captured: { value?: unknown } = {};
    const childSpec: StepSpec = {
      execute: async (_input, ctx) => {
        attempts++;
        const v = await ctx.suspend<string>({
          name: "approval",
          reason: "needs human signoff",
        });
        captured.value = v;
        return v;
      },
      input: undefined,
      name: "child",
    };
    const parentSpec: StepSpec<void, string> = {
      children: [childSpec],
      execute: async (_input, ctx) => ctx.children[0]?.run() as Promise<string>,
      input: undefined,
      name: "parent",
    };
    const parent = await Step.make(parentSpec);

    await expect(parent.run()).rejects.toBeDefined();
    expect(attempts).toBe(1);

    // Resolve from the *parent* frame — the shared resolutions Ref makes the
    // child's next ctx.suspend("approval") read it back.
    await parent.resolve("approval", "approved-by-mike");

    const out = await parent.run();
    expect(out).toBe("approved-by-mike");
    expect(attempts).toBe(2);
    expect(captured.value).toBe("approved-by-mike");
  });

  it("first call rejects with SuspendSignal; after resolve, next attempt resolves with the value", async () => {
    let attempts = 0;
    const captured: { value?: unknown } = {};

    const spec = asSpec<void, "ok">({
      execute: async (_input, ctx) => {
        attempts++;
        const v = await ctx.suspend<string>({
          name: "approval",
          reason: "needs human signoff",
        });
        captured.value = v;
        return "ok";
      },
      input: undefined,
      name: "suspend-flow",
    });

    const step = await Step.make(spec);

    // First attempt suspends — run() rejects.
    await expect(step.run()).rejects.toBeDefined();
    expect(attempts).toBe(1);
    expect(captured.value).toBeUndefined();

    // Resolve from outside the body — writes to the shared resolutions Ref.
    await step.resolve("approval", "approved");

    const second = await step.run();
    expect(second).toBe("ok");
    expect(attempts).toBe(2);
    expect(captured.value).toBe("approved");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Backward compatibility
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// 11. Agent integration — the motivating use case end-to-end
// ════════════════════════════════════════════════════════════════════════════

describe("ctx — agent / domain service injection (end-to-end)", () => {
  it("dynamic step decides what to fork based on agent output and prior siblings' results via ctx.resultOf", async () => {
    class Router {
      pickNext(seed: number): "double" | "triple" {
        return seed % 2 === 0 ? "double" : "triple";
      }
    }
    interface Ctx extends BaseContext {
      readonly router: Router;
    }

    const router = new Router();
    let captured: unknown = "<<NOT-SET>>";

    const doubleSpec = asSpec<number, number, Ctx>({
      execute: async (input) => input * 2,
      input: 0,
      name: "double",
    });
    const tripleSpec = asSpec<number, number, Ctx>({
      execute: async (input) => input * 3,
      input: 0,
      name: "triple",
    });

    const spec = asSpec<void, number, Ctx>({
      children: [
        asSpec<unknown, unknown>({
          execute: async () => 5,
          input: undefined,
          name: "seed",
        }),
      ],
      execute: async (_input, ctx) => {
        const seedValue = (await ctx.children[0]?.run()) as number;
        const fromCtx = ctx.resultOf<number>("seed");
        expect(fromCtx).toBe(5);
        const choice = ctx.router.pickNext(seedValue);
        const dyn = choice === "double" ? doubleSpec : tripleSpec;
        const dynStep = ctx.fork(dyn);
        captured = await dynStep.run(seedValue);
        return captured as number;
      },
      input: undefined,
      name: "agent-flow",
      seed: { router },
    });

    const step = await Step.make(spec);
    await step.run();

    expect(captured).toBe(15);
  });
});
