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
  InMemoryArtifactStore,
  InMemorySessionStore,
  ModelManager,
} from "@foundry.sh/marbles/lib";
import { file, Glob } from "bun";
import { initLogger } from "evlog";
import { z } from "zod";
import { backlog, serveBacklog } from "@/backlog";
import type { Context, Loadout } from "@/model/context";
import type { Encounter, Run, Step, Thread, Todo } from "@/model/thread";
import {
  emptyThread,
  latestEncounter,
  startEncounter,
  stepsOf,
  todosOf,
} from "@/model/thread";

const LIMIT = 8;
const MODELS = ["sonnet", "opus", "haiku"] as const;
const PROVIDER = "claude-code";
const WINDOW = 200_000;
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
  limit: WINDOW,
  models: MODELS,
  provider: PROVIDER,
  servers: [backlog],
  skills,
};

const thread = structuredClone(emptyThread);
let show: (thread: Thread) => void = () => undefined;
const paint = () => show(structuredClone(thread));

async function add(title: string): Promise<string> {
  const encounter = latestEncounter(thread);
  if (!encounter || todosOf(thread).length >= LIMIT) {
    return "The list is full. Finish the work inside this task.";
  }
  const previous = todosOf(thread).at(-1);
  const task = await tasks.create(
    { title },
    { dependsOn: previous ? [{ id: previous.id }] : [] }
  );
  encounter.todos.push({
    added: true,
    id: task.id,
    status: "pending",
    title,
  });
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

function equip({ effort, model }: Loadout) {
  const engine = new Engine({
    artifacts,
    askable: false,
    containers: () => Promise.reject(new Error("no sandbox runtime here")),
    models: new ModelManager({
      providers: [
        claudeCodeProvider({
          config: {
            available: true,
            defaultSettings: {
              allowedTools: backlog.tools.map(
                (tool) => `mcp__${backlog.name}__${tool.name}`
              ),
              effort,
              mcpServers: {
                [backlog.name]: { type: "http", url: served.url },
              },
              settingSources: ["project"],
              skills: skills.map((skill) => skill.name),
            },
          },
          env: process.env as Record<string, string>,
          models: [{ id: model, kind: "text", modelId: model }],
        }),
      ],
    }),
    root,
    sessions: new InMemorySessionStore(),
    workspaceId: "foundry-agent-harness",
  });
  return { engine, working: engine.agents.session(worker) };
}

type Equipped = ReturnType<typeof equip>;

const artifacts = new ArtifactManager({ store: new InMemoryArtifactStore() });
const equipped = new Map<string, Equipped>();

function pairing({ effort, model }: Loadout): string {
  return `${model}/${effort}`;
}

function equippedWith(loadout: Loadout): Equipped {
  const key = pairing(loadout);
  const kept = equipped.get(key) ?? equip(loadout);
  equipped.set(key, kept);
  return kept;
}

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

async function step(
  todo: Todo,
  encounter: Encounter,
  { working }: Equipped
): Promise<string> {
  const worked: Step = {
    streaming: true,
    text: "",
    title: todo.title,
    tools: [],
    usage: null,
  };
  encounter.steps.push(worked);
  todo.status = "running";
  paint();
  await tasks.start(todo.id);
  const session = await working;
  const reply = await session.generate(todo.title, {
    onText: (delta) => {
      worked.text += delta;
      paint();
    },
    onToolCall: ({ input, name, toolCallId }) => {
      worked.tools.push({
        detail: detail(input),
        id: toolCallId,
        name,
        startedAt: Date.now(),
        status: "running",
      });
      paint();
    },
    onToolResult: ({ isError, output, toolCallId }) => {
      const tool = worked.tools.find((each) => each.id === toolCallId);
      if (tool) {
        tool.status = isError ? "error" : "success";
        tool.error = isError ? failure(output) : undefined;
      }
      paint();
    },
  });
  worked.text = reply.text;
  worked.streaming = false;
  worked.usage = {
    input: reply.usage.inputTokens,
    output: reply.usage.outputTokens,
  };
  await tasks.complete(todo.id);
  todo.status = "success";
  paint();
  return reply.text;
}

async function work(encounter: Encounter, using: Equipped): Promise<void> {
  const kept: { path: string; text: string; title: string }[] = [];
  for (;;) {
    const [next] = (await tasks.ready({ limit: 1 })).items;
    const todo = todosOf(thread).find((each) => each.id === next?.id);
    if (!todo) {
      break;
    }
    const slug = todo.title.toLowerCase().replace(SLUG, "-").slice(0, 40);
    kept.push({
      path: `${kept.length + 1}-${slug}.md`,
      text: `# ${todo.title}\n\n${await step(todo, encounter, using)}\n`,
      title: todo.title,
    });
  }
  if (kept.length === 0) {
    return;
  }
  const version = await using.engine.artifacts.write(
    notes,
    Object.fromEntries(kept.map((note) => [note.path, note.text]))
  );
  thread.notes = {
    files: kept.map(({ path, title }) => ({ path, title })),
    version: version.id.slice(0, 8),
    versions: (thread.notes?.versions ?? 0) + 1,
  };
}

async function plan(encounter: Encounter, { engine }: Equipped): Promise<void> {
  const planning = await engine.agents.session(planner);
  const reply = await planning.generate(encounter.goal);
  encounter.plan = {
    input: reply.usage.inputTokens,
    output: reply.usage.outputTokens,
  };
  let previous = todosOf(thread).at(-1);
  for (const title of reply.output.tasks) {
    const task = await tasks.create(
      { title },
      { dependsOn: previous ? [{ id: previous.id }] : [] }
    );
    previous = { added: false, id: task.id, status: "pending", title };
    encounter.todos.push(previous);
  }
}

async function abandon(): Promise<void> {
  const open = todosOf(thread).filter(
    (todo) => todo.status === "pending" || todo.status === "running"
  );
  for (const todo of open) {
    todo.status = "error";
  }
  for (const each of stepsOf(thread)) {
    each.streaming = false;
    for (const tool of each.tools) {
      tool.status = tool.status === "running" ? "error" : tool.status;
    }
  }
  await Promise.allSettled(open.map((todo) => tasks.cancel(todo.id)));
}

export const run: Run = async (goal, shown, loadout) => {
  show = shown;
  const encounter = startEncounter({
    goal,
    id: `encounter-${thread.encounters.length + 1}`,
    loadout,
    startedAt: Date.now(),
    swapped: thread.encounters.length > 0 && !equipped.has(pairing(loadout)),
  });
  thread.encounters.push(encounter);
  thread.phase = "planning";
  paint();
  try {
    const using = equippedWith(loadout);
    await plan(encounter, using);
    thread.phase = "working";
    paint();
    await work(encounter, using);
    encounter.outcome = "finished";
  } catch (error) {
    encounter.outcome = "failed";
    encounter.error = error instanceof Error ? error.message : String(error);
    await abandon();
  } finally {
    encounter.endedAt = Date.now();
    thread.phase = "idle";
    paint();
  }
};

export async function close(): Promise<void> {
  await served.stop();
  await Promise.all(
    [...equipped.values()].map(({ engine }) => engine.dispose())
  );
}
