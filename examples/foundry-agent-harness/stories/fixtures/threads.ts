import { progressOf } from "@/game/progress";
import { scorecardOf } from "@/game/scorecard";
import type { Context, Weapon } from "@/model/context";
import type { Clock } from "@/model/screen";
import type { Encounter, Status, Step, Thread, Todo } from "@/model/thread";
import { emptyThread, startEncounter } from "@/model/thread";

const STARTED = 1_800_000_000_000;

const GOAL = "Read package.json here and explain how to run this example.";

const READ = "Read package.json in this directory";
const IDENTIFY = "Identify the scripts and what each one runs";
const WRITE = "Write the run instructions";
const TITLES = [READ, IDENTIFY, WRITE];

const WEAPON: Weapon = { effort: "medium", model: "sonnet" };

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

const finished: Step = {
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
  usage: { input: 16_000, output: 792 },
};

const opened: Encounter = startEncounter({
  goal: GOAL,
  id: "encounter-1",
  startedAt: STARTED,
  weapon: WEAPON,
});

function thread(encounter: Partial<Encounter>, more: Partial<Thread> = {}) {
  return {
    ...emptyThread,
    encounters: [{ ...opened, ...encounter }],
    ...more,
  } satisfies Thread;
}

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
  done: thread(
    {
      endedAt: STARTED + 42_000,
      outcome: "finished",
      plan: { input: 2400, output: 120 },
      steps: [finished],
      todos: todos("success", "success", "success"),
    },
    {
      notes: {
        files: [{ path: "1-read-package-json.md", title: READ }],
        version: "3f9a1c2e",
        versions: 1,
      },
    }
  ),
  failed: thread({
    endedAt: STARTED + 9000,
    error: "Claude Code stopped before the turn finished.",
    outcome: "failed",
    plan: { input: 2400, output: 120 },
    steps: [
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
        usage: null,
      },
    ],
    todos: todos("error", "error", "error"),
  }),
  idle: emptyThread,
  planning: thread({}, { phase: "planning" }),
  working: thread(
    {
      plan: { input: 2400, output: 120 },
      steps: [
        { ...finished, usage: { input: 180_000, output: 2000 } },
        {
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
          usage: null,
        },
      ],
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
    { phase: "working" }
  ),
} satisfies Record<string, Thread>;

const [ended = opened] = threads.done.encounters;
const [lost = opened] = threads.failed.encounters;

export const scorecards = {
  accepted: scorecardOf(ended, "accept", context.limit),
  consoled: scorecardOf(lost, "accept", context.limit),
  pending: scorecardOf(ended, null, context.limit),
  rejected: scorecardOf(ended, "reject", context.limit),
};

export const progress = {
  fresh: progressOf([]),
  seasoned: progressOf([
    scorecards.accepted,
    scorecards.accepted,
    scorecards.accepted,
    scorecards.accepted,
  ]),
};
