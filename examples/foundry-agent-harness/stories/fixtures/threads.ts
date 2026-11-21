import type { Context } from "@/model/context";
import type { Clock } from "@/model/screen";
import type { Message, Status, Thread, Todo } from "@/model/thread";
import { emptyThread } from "@/model/thread";

const STARTED = 1_800_000_000_000;

const GOAL = "Read package.json here and explain how to run this example.";

const READ = "Read package.json in this directory";
const IDENTIFY = "Identify the scripts and what each one runs";
const WRITE = "Write the run instructions";
const TITLES = [READ, IDENTIFY, WRITE];

const REPLY = [
  "This example starts with `bun run start`, which runs `src/main.tsx` on Bun.",
  "",
  "- `package.json` defines `start`, `test` and `typecheck`.",
  "- **Marbles** comes from the workspace, so build it first.",
  "",
  "```sh",
  "bun run build -F @foundry.sh/marbles",
  "bun run start",
  "```",
].join("\n");

function todos(...statuses: Status[]): Todo[] {
  return statuses.map((status, index) => ({
    added: false,
    id: `todo-${index + 1}`,
    status,
    title: TITLES[index] ?? `To-do ${index + 1}`,
  }));
}

const goal: Message = {
  kind: "goal",
  streaming: false,
  text: GOAL,
  title: "You",
  tools: [],
};

const finished: Message = {
  kind: "task",
  streaming: false,
  text: REPLY,
  title: READ,
  tools: [
    {
      detail: "task-notes",
      id: "tool-1",
      name: "Skill",
      startedAt: STARTED,
      status: "success",
    },
    {
      detail: "package.json",
      id: "tool-2",
      name: "Read",
      startedAt: STARTED,
      status: "success",
    },
  ],
};

const started: Thread = { ...emptyThread, messages: [goal], title: GOAL };

export const clock: Clock = { frame: 3, now: STARTED + 4200 };

export const context: Context = {
  limit: 200_000,
  models: ["sonnet", "opus", "haiku"],
  provider: "claude-code",
  servers: [
    {
      description: "The harness's own to-do list, served from this process.",
      name: "backlog",
      tools: [
        {
          description: "Add one follow-up to-do to the end of the list.",
          name: "add_todo",
        },
      ],
    },
  ],
  skills: [
    {
      description: "How to write the note for a finished task.",
      name: "task-notes",
    },
  ],
};

export const threads = {
  done: {
    ...started,
    context: 104_000,
    input: 18_400,
    messages: [goal, finished],
    notes: {
      files: [{ path: "1-read-package-json.md", title: READ }],
      version: "3f9a1c2e",
      versions: 1,
    },
    output: 912,
    todos: todos("success", "success", "success"),
  },
  failed: {
    ...started,
    context: 150_000,
    messages: [
      goal,
      {
        ...finished,
        text: "",
        tools: [
          {
            detail: "missing.json",
            error: "File does not exist.",
            id: "tool-1",
            name: "Read",
            startedAt: STARTED,
            status: "error",
          },
        ],
      },
      {
        kind: "error",
        streaming: false,
        text: "Claude Code stopped before the turn finished.",
        title: "The harness stopped",
        tools: [],
      },
    ],
    todos: todos("error", "error", "error"),
  },
  idle: emptyThread,
  planning: { ...started, phase: "planning" },
  working: {
    ...started,
    context: 62_000,
    messages: [
      goal,
      finished,
      {
        kind: "task",
        streaming: true,
        text: "",
        title: IDENTIFY,
        tools: [
          {
            detail: "bun run --help",
            id: "tool-3",
            name: "Bash",
            startedAt: STARTED,
            status: "running",
          },
        ],
      },
    ],
    phase: "working",
    todos: [
      ...todos("success", "running", "pending"),
      {
        added: true,
        id: "todo-4",
        status: "pending",
        title: "Check the Bun version",
      },
    ],
  },
} satisfies Record<string, Thread>;
