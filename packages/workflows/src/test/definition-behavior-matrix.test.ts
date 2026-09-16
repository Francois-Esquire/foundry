import { describe, expect, it } from "vitest";

import type { DefinitionGraphBuilder } from "../definitions";
import type { StepContext } from "../step";

import { Step } from "../step";
import { bail } from "../types";
import { Workflow } from "../workflow";
import { materializeWorkflow } from "./helpers/definitions";
import { collectChunks } from "./helpers/streams";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class BailingStep extends Step<void, string> {
  readonly definitionKey = "matrix.bail";

  protected execute(): Promise<string> {
    return Promise.resolve(bail({ code: "declined" }) as never);
  }
}

class ThrowingStep extends Step<void, string> {
  readonly definitionKey = "matrix.throw";

  protected execute(): Promise<string> {
    return Promise.reject(new Error("definition throw"));
  }
}

class StreamingStep extends Step<void, string> {
  readonly definitionKey = "matrix.stream";

  protected async *execute(): AsyncGenerator<string, string, unknown> {
    yield "compiled chunk";
    return "stream complete";
  }
}

class SuspendingStep extends Step<void, string> {
  readonly definitionKey = "matrix.suspend";

  protected async execute(
    _input: void,
    context: StepContext<void, string>
  ): Promise<string> {
    return context.suspend<string>({ name: "approval", reason: "matrix" });
  }
}

class ForkingStep extends Step<void, string> {
  readonly definitionKey = "matrix.fork";
  child: Step<undefined, string> | undefined;

  protected async execute(
    _input: void,
    context: StepContext<void, string>
  ): Promise<string> {
    this.child = context.fork({
      execute: async () => "child complete",
      input: undefined,
      name: "dynamic-child",
    });
    return "parent complete";
  }
}

class FastStep extends Step<void, string> {
  readonly definitionKey = "matrix.fast";

  protected async execute(): Promise<string> {
    await sleep(5);
    return "fast";
  }
}

class SlowStep extends Step<void, string> {
  readonly definitionKey = "matrix.slow";
  readonly started = Promise.withResolvers<void>();
  readonly finish = Promise.withResolvers<void>();

  protected async execute(): Promise<string> {
    this.started.resolve();
    await this.finish.promise;
    return "slow";
  }
}

interface SharedContext {
  readonly name: string;
  readonly tenant: string;
  readonly traceId?: string;
}

class SharedContextStep extends Step<string, string, SharedContext> {
  readonly definitionKey = "matrix.shared-context";

  protected execute(
    input: string,
    context: StepContext<string, string, SharedContext>
  ): Promise<string> {
    return Promise.resolve(
      `${context.tenant}:${context.traceId ?? "none"}:${input}`
    );
  }
}

class SharedContextWorkflow extends Workflow<string, string, SharedContext> {
  readonly definitionKey = "matrix.shared-context-workflow";
  readonly #child = new SharedContextStep();

  protected define(
    graph: DefinitionGraphBuilder<
      string,
      string,
      Record<never, never>,
      SharedContext
    >
  ): void {
    graph
      .step("child", this.#child, ({ input }) => input)
      .output(({ child }) => child);
  }
}

class SingleStepWorkflow extends Workflow<void, string> {
  readonly definitionKey: string;

  constructor(
    key: string,
    private readonly source: Step<void, string>
  ) {
    super();
    this.definitionKey = key;
  }

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.step("body", this.source, () => undefined).output(({ body }) => body);
  }
}

class RaceWorkflow extends Workflow<void, { winner: string; value: string }> {
  readonly definitionKey = "matrix.race-workflow";
  readonly #fast = new FastStep();
  readonly slow = new SlowStep();

  protected define(
    graph: DefinitionGraphBuilder<void, { winner: string; value: string }>
  ): void {
    graph
      .race("winner", { fast: this.#fast, slow: this.slow })
      .output(({ winner }) => winner as { winner: string; value: string });
  }
}

describe("compiled definition behavior matrix", () => {
  it("merges create and run context, with run values taking precedence", async () => {
    const step = new SharedContextStep();

    await expect(
      step.create({ tenant: "create" }).run("body", { traceId: "trace" })
    ).resolves.toBe("create:trace:body");
    await expect(
      step.create({ tenant: "create" }).run("body", { tenant: "run" })
    ).resolves.toBe("run:none:body");
    await expect(step.run("sugar", { tenant: "direct" })).resolves.toBe(
      "direct:none:sugar"
    );
  });

  it("shares the merged context with compiled child definitions", async () => {
    const workflow = new SharedContextWorkflow().create({ tenant: "create" });

    await expect(workflow.run("body", { traceId: "trace" })).resolves.toBe(
      "create:trace:body"
    );
  });

  it("keeps Bail distinct from thrown failures", async () => {
    await expect(
      new SingleStepWorkflow("matrix.bail-workflow", new BailingStep()).run()
    ).rejects.toThrow(/bailed/);
    await expect(
      new SingleStepWorkflow("matrix.throw-workflow", new ThrowingStep()).run()
    ).rejects.toThrow("definition throw");
  });

  it("routes async-generator chunks through the compiled root stream", async () => {
    const runtime = materializeWorkflow(
      new SingleStepWorkflow("matrix.streaming-workflow", new StreamingStep()),
      undefined
    );
    const chunks = collectChunks(runtime.root, { take: 1 });

    await expect(runtime.run()).resolves.toBe("stream complete");
    expect(chunks.chunks).toMatchObject([
      { payload: { kind: "text", text: "compiled chunk" } },
    ]);
  });

  it("suspends and resumes without leaving the compiled substrate", async () => {
    const runtime = materializeWorkflow(
      new SingleStepWorkflow("matrix.suspend-workflow", new SuspendingStep()),
      undefined
    );

    await runtime.run().catch(() => undefined);
    expect(runtime.status).toBe("suspended");
    await runtime.resume("approval", "approved");
    await expect(runtime.run()).resolves.toBe("approved");
    expect(runtime.root.steps["matrix.suspend-workflow.body"]?.status).toBe(
      "complete"
    );
  });

  it("preserves dynamic fork cancellation under the compiled root", async () => {
    const source = new ForkingStep();
    const runtime = materializeWorkflow(
      new SingleStepWorkflow("matrix.fork-workflow", source),
      undefined
    );

    await expect(runtime.run()).resolves.toBe("parent complete");
    runtime.root.abort("matrix cancellation");

    expect(source.child?.aborted).toBe(true);
    expect(
      runtime.root.steps["matrix.fork-workflow.body.dynamic-child"]?.status
    ).toBe("complete");
  });

  it("returns a race winner before its compiled loser settles", async () => {
    const workflow = new RaceWorkflow();
    const result = workflow.run();
    try {
      await workflow.slow.started.promise;
      await expect(result).resolves.toEqual({
        value: "fast",
        winner: "fast",
      });
    } finally {
      workflow.slow.finish.resolve();
    }
  });
});
