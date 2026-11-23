import type { Weapon } from "@/model/context";

export type Status = "pending" | "running" | "success" | "error";

export interface Todo {
  added: boolean;
  id: string;
  status: Status;
  title: string;
}

export interface ToolUse {
  detail: string;
  error?: string;
  id: string;
  name: string;
  startedAt: number;
  status: Status;
}

export interface Tokens {
  readonly input: number;
  readonly output: number;
}

export interface Step {
  streaming: boolean;
  text: string;
  title: string;
  tools: ToolUse[];
  usage: Tokens | null;
}

export type Outcome = "running" | "finished" | "failed";

export interface Encounter {
  endedAt: number | null;
  error?: string;
  readonly goal: string;
  readonly id: string;
  outcome: Outcome;
  plan: Tokens;
  readonly rearmed: boolean;
  readonly startedAt: number;
  steps: Step[];
  todos: Todo[];
  readonly weapon: Weapon;
}

export interface Notes {
  files: { path: string; title: string }[];
  version: string;
  versions: number;
}

export interface Thread {
  encounters: Encounter[];
  id: string;
  notes?: Notes;
  phase: "idle" | "planning" | "working";
}

export type Run = (
  goal: string,
  show: (thread: Thread) => void,
  weapon: Weapon
) => Promise<void>;

const NO_TOKENS: Tokens = { input: 0, output: 0 };

const SERVER_TOOL = /^mcp__(.+?)__(.+)$/;

export function toolLabel(name: string): string {
  return name.replace(SERVER_TOOL, "$1 · $2");
}

export const emptyThread: Thread = {
  encounters: [],
  id: "thread-1",
  phase: "idle",
};

export function startEncounter({
  goal,
  id,
  rearmed = false,
  startedAt,
  weapon,
}: {
  readonly goal: string;
  readonly id: string;
  readonly rearmed?: boolean;
  readonly startedAt: number;
  readonly weapon: Weapon;
}): Encounter {
  return {
    endedAt: null,
    goal,
    id,
    outcome: "running",
    plan: NO_TOKENS,
    rearmed,
    startedAt,
    steps: [],
    todos: [],
    weapon,
  };
}

export function latestEncounter(thread: Thread): Encounter | undefined {
  return thread.encounters.at(-1);
}

export function isEnded(encounter: Encounter | undefined): boolean {
  return encounter !== undefined && encounter.outcome !== "running";
}

export function titleOf(thread: Thread): string {
  return thread.encounters[0]?.goal ?? "New thread";
}

export function todosOf(thread: Thread): Todo[] {
  return thread.encounters.flatMap((encounter) => encounter.todos);
}

export function stepsOf(thread: Thread): Step[] {
  return thread.encounters.flatMap((encounter) => encounter.steps);
}

function added(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output };
}

export function tokensOf(encounter: Encounter): Tokens {
  return encounter.steps.reduce(
    (sum, step) => added(sum, step.usage ?? NO_TOKENS),
    encounter.plan
  );
}

export function threadTokens(thread: Thread): Tokens {
  return thread.encounters.map(tokensOf).reduce(added, NO_TOKENS);
}

export function isBusy(thread: Thread): boolean {
  return thread.phase !== "idle";
}

export function finishedTodos(todos: readonly Todo[]): number {
  return todos.filter((todo) => todo.status === "success").length;
}

export function isAnimating(thread: Thread): boolean {
  return (
    isBusy(thread) ||
    todosOf(thread).some((todo) => todo.status === "running") ||
    stepsOf(thread).some((step) =>
      step.tools.some((tool) => tool.status === "running")
    )
  );
}

export interface Tally {
  readonly count: number;
  readonly failed: number;
  readonly name: string;
  readonly running: boolean;
}

export function toolTallies(steps: readonly Step[]): Tally[] {
  const tallies = new Map<string, Tally>();
  for (const step of steps) {
    for (const tool of step.tools) {
      const kept = tallies.get(tool.name);
      tallies.set(tool.name, {
        count: (kept?.count ?? 0) + 1,
        failed: (kept?.failed ?? 0) + (tool.status === "error" ? 1 : 0),
        name: tool.name,
        running: (kept?.running ?? false) || tool.status === "running",
      });
    }
  }
  return [...tallies.values()].sort((a, b) => b.count - a.count);
}

export function hasFailed(thread: Thread): boolean {
  return latestEncounter(thread)?.outcome === "failed";
}

export function compactCount(count: number): string {
  return count < 1000
    ? String(count)
    : `${(count / 1000).toFixed(1).replace(".0", "")}k`;
}
