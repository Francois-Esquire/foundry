import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayProvider } from "@foundry/models/gateway";
import { afterEach, expect, it } from "vitest";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import type { Session, SessionReply } from "~/lib/types";

afterEach(() => {
  catalog.reset();
});

for (const harness of ["builtin", "claude-code", "codex"] as const) {
  it(`${harness} asks, waits for approval, resumes turns, respects denial, and cancels through the Marbles feed in MicroSandbox`, async () => {
    const parent = await mkdtemp(
      join(tmpdir(), `marbles-interactive-${harness}-`)
    );
    const root = join(parent, "workspace");
    await mkdir(root);
    const engine = createEngine({
      askable: true,
      catalog,
      dry: false,
      only: [],
      print: () => undefined,
      providers:
        harness === "builtin"
          ? [
              gatewayProvider({
                config: {
                  apiKey: process.env.AI_GATEWAY_API_KEY,
                  baseURL: "https://ai-gateway.vercel.sh/v1",
                },
              }),
            ]
          : [],
      root,
      stateDir: join(parent, "state"),
      workspaceId: "interactive",
    });
    const model = {
      builtin: "openai/gpt-5-mini",
      "claude-code": "sonnet",
      codex: "gpt-5.5",
    }[harness];
    const questionTool =
      harness === "claude-code" ? "AskUserQuestion" : "ask_user";
    let bodies = 0;
    let phase = 0;
    let session: Session | undefined;
    const replies: SessionReply[] = [];
    step("interactive-coding").do(async ({ agents, sandboxes }) => {
      bodies += 1;
      const sandbox = await sandboxes.start({
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
      session = await agents.session(
        {
          id: `interactive-${harness}`,
          kind: "agent",
          model,
          prompt: `Work only in /workspace. Use ${questionTool} whenever asked to ask the user. Use the shell tool for requested bun commands. Do not use file-edit tools or alternate commands. When a tool is denied, stop that task and report the refusal without retrying or finding another route.`,
          provider: harness === "builtin" ? "gateway" : harness,
        },
        {
          profile: {
            allowedTools:
              harness === "builtin"
                ? ["read", "glob", "grep"]
                : ["Read", "Glob", "Grep", "Edit", "Write"],
            disallowedTools: [],
            maxSteps: 12,
            mode: "attended",
            unresolved: "ask",
          },
          sandbox,
        }
      );
      phase = 1;
      replies.push(
        await session.generate(
          `First use ${questionTool} to ask the user for a marker string. Ask exactly one free-text question. After receiving their answer, run a bun -e shell command using node:fs writeFileSync to write that exact marker to /workspace/first.txt. Wait for tool authorization. Report the result.`,
          { signal: AbortSignal.timeout(150_000) }
        )
      );
      phase = 2;
      replies.push(
        await session.generate(
          "Without asking again or reading any file, recall the marker the user supplied in the preceding turn. Use a bun -e shell command to write it to /workspace/second.txt and report the marker in your answer. Do not use file-edit tools.",
          { signal: AbortSignal.timeout(150_000) }
        )
      );
      phase = 3;
      replies.push(
        await session.generate(
          'Use the shell tool to run exactly: bun -e \'require("node:fs").writeFileSync("/workspace/denied.txt", "forbidden")\'. If permission is refused, stop and report the refusal. Do not retry or use other tools.',
          { signal: AbortSignal.timeout(150_000) }
        )
      );
      phase = 4;
      replies.push(
        await session.generate(
          `Use ${questionTool} to ask one free-text question: "What should the cancellation marker be?" Wait for the user answer before doing anything else. Only after receiving an answer, run a shell command to write it to /workspace/cancelled.txt.`,
          { signal: AbortSignal.timeout(150_000) }
        )
      );
      return replies;
    });
    await engine.start();
    let settled = false;
    let failure: unknown;
    try {
      const launched = await engine.launch("interactive-coding", {});
      launched.result.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          failure = error;
        }
      );
      const nextEntry = async (): Promise<FeedEntrySnapshot> => {
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          const entry = (await engine.feed()).find(
            (item) => item.input?.status === "open"
          );
          if (entry) {
            return entry;
          }
          if (settled) {
            throw new Error(
              `Agent run ended before its next input at phase ${phase}: ${String(failure ?? "completed")}`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`No feed input at phase ${phase}`);
      };
      const marker = `marker-${crypto.randomUUID()}`;
      const question = await nextEntry();
      expect(question.input?.mode).toBe("question");
      expect(bodies).toBe(1);
      expect(
        (await engine.runs()).find((run) => run.id === launched.id)?.status
      ).toBe("running");
      expect(existsSync(join(root, "first.txt"))).toBe(false);
      if (question.input?.choices.length) {
        await engine.answer(question.id, "Write another answer");
      }
      await engine.answer(question.id, marker);
      const firstApproval = await nextEntry();
      expect(firstApproval.input?.mode).toBe("approval");
      expect(existsSync(join(root, "first.txt"))).toBe(false);
      await engine.answer(firstApproval.id, "Approve once");
      const secondApproval = await nextEntry();
      expect(phase).toBe(2);
      expect(await readFile(join(root, "first.txt"), "utf8")).toBe(marker);
      expect(existsSync(join(root, "second.txt"))).toBe(false);
      await engine.answer(secondApproval.id, "Approve once");
      let entry = await nextEntry();
      expect(phase).toBe(3);
      expect(await readFile(join(root, "second.txt"), "utf8")).toBe(marker);
      expect(replies[1]?.text).toContain(marker);
      while (entry.input?.mode === "approval") {
        await engine.answer(entry.id, {
          choice: "Deny",
          note: "This operation is not authorized. Stop without retrying.",
        });
        entry = await nextEntry();
      }
      expect(phase).toBe(4);
      expect(entry.input?.mode).toBe("question");
      expect(existsSync(join(root, "denied.txt"))).toBe(false);
      expect(
        replies.slice(0, 3).every((reply) => reply.status === "complete")
      ).toBe(true);
      const history = await session?.harness.store?.listMessages(
        session.ref.id
      );
      const mappings = history
        ?.flatMap((message) => message.parts)
        .filter((part) => part.type === "harness_session");
      if (harness !== "builtin") {
        expect(mappings?.length).toBeGreaterThanOrEqual(1);
        expect(
          new Set(mappings?.map((part) => part.nativeSessionId)).size
        ).toBe(1);
      }
      await engine.cancel(launched.id);
      await expect(launched.result).rejects.toThrow("cancelled");
      await expect(engine.answer(entry.id, "too late")).rejects.toThrow();
      expect(existsSync(join(root, "cancelled.txt"))).toBe(false);
      expect(
        (await engine.feed()).find((item) => item.id === entry.id)?.input
          ?.status
      ).toBe("cancelled");
      expect(bodies).toBe(1);
    } finally {
      await engine.stop({ cancel: true });
      await engine.dispose();
      await rm(parent, { force: true, recursive: true });
    }
  }, 600_000);
}
