import {
  agent,
  artifact,
  defineSkill,
  Output,
  tasks,
} from "@foundry.sh/marbles";
import {
  ArtifactManager,
  claudeCodeProvider,
  Engine,
  InMemorySessionStore,
  MemoryArtifactStore,
  Models,
} from "@foundry.sh/marbles/lib";
import { file, Glob } from "bun";
import { initLogger } from "evlog";
import { z } from "zod";
import { backlog, serveBacklog } from "@/backlog";
import type { Context } from "@/model/context";
import type { Message, Run, Thread, Todo } from "@/model/thread";
import { emptyThread } from "@/model/thread";

const LIMIT = 8;
const MODEL = "sonnet";
const SLUG = /[^a-z0-9]+/g;
const root = process.cwd();

initLogger({ enabled: false });

const skills = await Promise.all(
  [
    ...new Glob(".claude/skills/*/SKILL.md").scanSync({
      cwd: root,
      dot: true,
    }),
  ]
    .sort()
    .map(async (path) => {
      const { description, name } = defineSkill({
        manifest: await file(`${root}/${path}`).text(),
      });
      return { description, name };
    })
);

export const context: Context = {
  model: `claude-code/${MODEL}`,
  servers: [backlog],
  skills,
};

const thread = structuredClone(emptyThread);
let show: (thread: Thread) => void = () => undefined;
const paint = () => show(structuredClone(thread));

async function add(title: string): Promise<string> {
  if (thread.todos.length >= LIMIT) {
    return "The list is full. Finish the work inside this task.";
  }
  const previous = thread.todos.at(-1);
  const task = await tasks.create(
    { title },
    { dependsOn: previous ? [{ id: previous.id }] : [] }
  );
  thread.todos.push({ added: true, id: task.id, status: "pending", title });
  paint();
  return `Added "${title}" to the end of the list.`;
}

const served = serveBacklog(add);

const planner = agent({
  name: "harness-planner",
  prompt:
    "Break the goal into two to four small tasks, in the order to do them. Give each a short imperative title of at most eight words. Do not start the work.",
  settings: {
    output: Output.object({
      schema: z.object({ tasks: z.array(z.string()).min(1).max(4) }),
    }),
  },
});

const worker = agent({
  name: "harness-worker",
  prompt: `Do the one task you are given and reply with the finished work in Markdown. Do not edit files. Load and follow these skills before you reply: ${skills.map((skill) => skill.name).join(", ") || "none"}. When the task shows necessary work the to-do list does not cover, add it with add_todo, at most once, and do not mention the list otherwise.`,
});

const notes = artifact({ name: "Agent harness notes", type: "text/markdown" });

const engine = new Engine({
  artifacts: new ArtifactManager({ store: new MemoryArtifactStore() }),
  askable: false,
  containers: () => Promise.reject(new Error("no sandbox runtime here")),
  models: new Models({
    providers: [
      claudeCodeProvider({
        config: {
          available: true,
          defaultSettings: {
            allowedTools: backlog.tools.map(
              (tool) => `mcp__${backlog.name}__${tool.name}`
            ),
            mcpServers: { [backlog.name]: { type: "http", url: served.url } },
            settingSources: ["project"],
            skills: skills.map((skill) => skill.name),
          },
        },
        env: process.env as Record<string, string>,
        models: [{ id: MODEL, kind: "text", modelId: MODEL }],
      }),
    ],
  }),
  root,
  sessions: new InMemorySessionStore(),
  workspaceId: "foundry-agent-harness",
});

const working = engine.agents.session(worker);

function detail(input: unknown): string {
  const values = Object.values(
    typeof input === "object" && input !== null ? input : {}
  );
  const first = values.find((value) => typeof value === "string") ?? "";
  return (String(first).split("\n")[0] ?? "").replaceAll(`${root}/`, "");
}

function failure(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return (text ?? "").trim().split("\n")[0] ?? "";
}

async function turn(todo: Todo): Promise<string> {
  const message: Message = {
    kind: "task",
    streaming: true,
    text: "",
    title: todo.title,
    tools: [],
  };
  thread.messages.push(message);
  todo.status = "running";
  paint();
  await tasks.start(todo.id);
  const session = await working;
  const reply = await session.generate(todo.title, {
    onText: (delta) => {
      message.text += delta;
      paint();
    },
    onToolCall: ({ input, name, toolCallId }) => {
      message.tools.push({
        detail: detail(input),
        id: toolCallId,
        name: name.replace("mcp__", "").replace("__", " · "),
        startedAt: Date.now(),
        status: "running",
      });
      paint();
    },
    onToolResult: ({ isError, output, toolCallId }) => {
      const tool = message.tools.find((each) => each.id === toolCallId);
      if (tool) {
        tool.status = isError ? "error" : "success";
        tool.error = isError ? failure(output) : undefined;
      }
      paint();
    },
  });
  message.text = reply.text;
  message.streaming = false;
  thread.input += reply.usage.inputTokens;
  thread.output += reply.usage.outputTokens;
  await tasks.complete(todo.id);
  todo.status = "success";
  paint();
  return reply.text;
}

async function work(): Promise<void> {
  const kept: { path: string; text: string; title: string }[] = [];
  for (;;) {
    const [next] = (await tasks.ready({ limit: 1 })).items;
    const todo = thread.todos.find((each) => each.id === next?.id);
    if (!todo) {
      break;
    }
    const slug = todo.title.toLowerCase().replace(SLUG, "-").slice(0, 40);
    kept.push({
      path: `${kept.length + 1}-${slug}.md`,
      text: `# ${todo.title}\n\n${await turn(todo)}\n`,
      title: todo.title,
    });
  }
  if (kept.length === 0) {
    return;
  }
  const version = await engine.artifacts.write(
    notes,
    Object.fromEntries(kept.map((note) => [note.path, note.text]))
  );
  thread.notes = {
    files: kept.map(({ path, title }) => ({ path, title })),
    version: version.id.slice(0, 8),
    versions: (thread.notes?.versions ?? 0) + 1,
  };
}

async function plan(goal: string): Promise<void> {
  const planning = await engine.agents.session(planner);
  const reply = await planning.generate(goal);
  thread.input += reply.usage.inputTokens;
  thread.output += reply.usage.outputTokens;
  let previous = thread.todos.at(-1);
  for (const title of reply.output.tasks) {
    const task = await tasks.create(
      { title },
      { dependsOn: previous ? [{ id: previous.id }] : [] }
    );
    previous = { added: false, id: task.id, status: "pending", title };
    thread.todos.push(previous);
  }
}

async function abandon(): Promise<void> {
  for (const todo of thread.todos) {
    if (todo.status === "pending" || todo.status === "running") {
      todo.status = "error";
      await tasks.cancel(todo.id);
    }
  }
  for (const message of thread.messages) {
    message.streaming = false;
    for (const tool of message.tools) {
      tool.status = tool.status === "running" ? "error" : tool.status;
    }
  }
}

export const run: Run = async (goal, shown) => {
  show = shown;
  thread.title = thread.messages.length === 0 ? goal : thread.title;
  thread.messages.push({
    kind: "goal",
    streaming: false,
    text: goal,
    title: "You",
    tools: [],
  });
  thread.phase = "planning";
  paint();
  try {
    await plan(goal);
    thread.phase = "working";
    paint();
    await work();
  } catch (error) {
    await abandon();
    thread.messages.push({
      kind: "error",
      streaming: false,
      text: error instanceof Error ? error.message : String(error),
      title: "The harness stopped",
      tools: [],
    });
  }
  thread.phase = "idle";
  paint();
};

export async function close(): Promise<void> {
  await served.stop();
  await engine.dispose();
}
