import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore } from "@foundry/agents/session";
import { ModelManager } from "@foundry/models";
import { gatewayProvider } from "@foundry/models/gateway";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMicrosandboxRuntime } from "@foundry/sandbox/container/microsandbox-runtime";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { expect, it } from "vitest";
import { AgentsManager } from "~/lib/managers/agents";
import { SandboxesManager } from "~/lib/managers/sandboxes";
import { RunScope, runs } from "~/lib/run-scope";

for (const harness of ["builtin", "claude-code", "codex"] as const) {
  it(`${harness} fixes a failing fixture and runs its tests in MicroSandbox`, async () => {
    const keyName = {
      builtin: "AI_GATEWAY_API_KEY",
      "claude-code": "ANTHROPIC_API_KEY",
      codex: "OPENAI_API_KEY",
    }[harness];
    const apiKey = process.env[keyName];
    if (!apiKey && harness === "builtin") {
      throw new Error(
        `Live ${harness} verification requires ${keyName} through the host environment. No host login directories are mounted.`
      );
    }
    const root = await mkdtemp(join(tmpdir(), `marbles-${harness}-`));
    const runtime = createMicrosandboxRuntime();
    const containers = createContainers({
      allowedMountRoots: [root],
      instanceLabel: "marbles-harness-test",
      runtime,
      store: createMemoryContainerStore(),
    });
    const store = new InMemorySessionStore();
    const provider = harness === "builtin" ? "gateway" : harness;
    const modelId = {
      builtin: "openai/gpt-5-mini",
      "claude-code": "sonnet",
      codex: "gpt-5.5",
    }[harness];
    const models = new ModelManager({
      providers:
        harness === "builtin"
          ? [
              gatewayProvider({
                config: { apiKey, baseURL: "https://ai-gateway.vercel.sh/v1" },
              }),
            ]
          : [],
    });
    const scope = new RunScope(`live-${crypto.randomUUID()}`, root);
    const frame = scope.frame(["coding"]);
    const written: unknown[] = [];
    const args = {
      cwd: root,
      frame,
      scope,
      write: (value: unknown) => written.push(value),
    };
    try {
      await writeFile(
        join(root, "sum.ts"),
        "export const sum = (a: number, b: number) => a - b;\n"
      );
      await writeFile(
        join(root, "sum.test.ts"),
        "import { test, expect } from 'bun:test'; import { sum } from './sum'; test('adds', () => expect(sum(2, 3)).toBe(5));\n"
      );
      const sandbox = await new SandboxesManager({
        containers: () => Promise.resolve(containers),
        home: root,
        root,
      })
        .scoped(args)
        .start({
          executable: true,
          image: "docker.io/oven/bun:1-slim",
          network:
            harness === "builtin"
              ? "disabled"
              : {
                  destinations: [
                    {
                      host:
                        harness === "claude-code"
                          ? "api.anthropic.com"
                          : "chatgpt.com",
                      ports: [443],
                    },
                  ],
                  mode: "allowlist",
                },
        });
      expect((await sandbox.exec(["bun", "test"])).exitCode).not.toBe(0);
      const session = await new AgentsManager({
        defaultExecutor: () => ({ harness, model: modelId, provider }),
        models,
        root,
        sessions: store,
        skills: async () => [],
        warn: () => undefined,
      })
        .scoped(args)
        .session(
          {
            id: `fixture-${harness}`,
            kind: "agent",
            model: modelId,
            prompt:
              "Fix coding bugs in /workspace. Use the available tools and run bun test after editing. Do not change test files.",
            provider,
          },
          {
            apiKey,
            profile: {
              allowedTools:
                harness === "builtin"
                  ? ["read", "write", "edit", "glob", "grep", "bash"]
                  : [
                      "Read",
                      "Edit",
                      "Write",
                      "Glob",
                      "Grep",
                      "Bash(bun test:*)",
                    ],
              disallowedTools: [],
              maxSteps: 12,
              mode: "scheduled",
              unresolved: "deny",
            },
            sandbox,
          }
        );
      const reply = await session.generate(
        "Read sum.ts and sum.test.ts. Correct the sum implementation and run bun test. Report its result.",
        { signal: AbortSignal.timeout(180_000) }
      );
      const diagnostics = JSON.stringify(reply.parts)
        .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
        .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [redacted]");
      expect(reply.status, diagnostics).not.toBe("error");
      expect((await sandbox.exec(["bun", "test"])).exitCode).toBe(0);
      expect(await readFile(join(root, "sum.ts"), "utf8")).not.toContain(
        "a - b"
      );
      const messages = await store.listMessages(session.ref.id);
      expect(
        messages.some((message) =>
          message.parts.some(
            (part) =>
              part.type === "tool_result" || part.type === "harness_tool"
          )
        )
      ).toBe(true);
      if (apiKey) {
        expect(JSON.stringify(written)).not.toContain(apiKey);
      }
    } finally {
      await scope.settle();
      await containers.shutdown();
      await models.dispose();
      runs.clear();
      await rm(root, { force: true, recursive: true });
    }
  });
}
