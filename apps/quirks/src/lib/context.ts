import type { StepContext } from "@foundry/workflows/step";
import { z } from "zod";

import { FEED_INPUT_KIND, FEED_POST_EVENT, feedPayload } from "~/feed/entry";
import { createLog } from "~/lib/log";

import type { Bindings } from "./bindings";
import type { Frame, RunScope } from "./run-scope";
import type {
  Approval,
  ApprovalRequest,
  ArtifactDefinition,
  ArtifactFiles,
  Ask,
  Context,
  Question,
  Report,
  ReportEntry,
  Run,
} from "./types";

/**
 * Builds the one object a body receives from the run scope, the frame, and
 * the package's step context. Everything here is pre-wired: the signal is
 * the frame's, the stream is the step's, and every ask or report is
 * identified by its position in the body.
 */

const ASK_NAME = "quirks.ask";
const APPROVE = "approve";
const REJECT = "reject";

const questionSchema = z.object({
  body: z.string().default(""),
  choices: z
    .array(z.string().trim().min(1, "choices cannot be empty"))
    .max(9, "at most 9 choices")
    .default([]),
  key: z.string().trim().min(1).optional(),
  mode: z.enum(["question", "approval"]),
  title: z.string().trim().min(1, "questions need a title"),
});

interface AskArgs {
  readonly ctx: StepContext;
  readonly frame: Frame;
  readonly scope: RunScope;
}

interface Answered {
  readonly choice: string;
  readonly note?: string;
}

/** A resolution is the choice, or the choice with a note. */
function answered(resolution: unknown, mode: string): Answered {
  if (typeof resolution === "string") {
    return { choice: resolution };
  }
  if (
    typeof resolution === "object" &&
    resolution !== null &&
    "choice" in resolution &&
    typeof resolution.choice === "string"
  ) {
    const note =
      "note" in resolution && typeof resolution.note === "string"
        ? resolution.note
        : undefined;
    return note
      ? { choice: resolution.choice, note }
      : { choice: resolution.choice };
  }
  throw new Error(`ask.${mode}: the answer was not text`);
}

async function suspendFor(
  { ctx, frame, scope }: AskArgs,
  raw: z.input<typeof questionSchema>
): Promise<Answered> {
  const parsed = questionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `ask.${raw.mode}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }
  const { occurrence } = scope.claim(frame, "ask");
  const request = {
    ...parsed.data,
    key: parsed.data.key ?? `ask:${occurrence}`,
  };
  // Each ask gets its own suspension name, so a name-level resolution can
  // never answer a different ask in the same body.
  const resolution = await ctx.suspend<unknown>({
    kind: FEED_INPUT_KIND,
    name: parsed.data.key
      ? `${ASK_NAME}:${parsed.data.key}`
      : `${ASK_NAME}#${occurrence}`,
    reason: request.title,
    request,
  });
  const answer = answered(resolution, raw.mode);
  if (request.choices.length > 0 && !request.choices.includes(answer.choice)) {
    throw new Error(
      `ask.${raw.mode}: "${answer.choice}" is not one of the choices`
    );
  }
  return answer;
}

function buildAsk(args: AskArgs): Ask {
  return {
    async approval(request: ApprovalRequest): Promise<Approval> {
      const answer = await suspendFor(args, {
        ...request,
        choices: [APPROVE, REJECT],
        mode: "approval",
      });
      return {
        approved: answer.choice === APPROVE,
        ...(answer.note === undefined ? {} : { note: answer.note }),
      };
    },
    async question(question: Question): Promise<string> {
      const answer = await suspendFor(args, {
        ...(question.body === undefined ? {} : { body: question.body }),
        ...(question.choices === undefined
          ? {}
          : { choices: [...question.choices] }),
        ...(question.key === undefined ? {} : { key: question.key }),
        mode: "question",
        title: question.title,
      });
      return answer.choice;
    },
  };
}

interface ReportArgs extends AskArgs {
  readonly context: () => Context<unknown>;
  readonly root: string;
}

function buildReport({ ctx, frame, root, scope, context }: ReportArgs): Report {
  const post = (
    kind: "milestone" | "result",
    entry: ReportEntry,
    artifact?: { readonly artifactId: string; readonly contentId: string }
  ) => {
    const { occurrence } = scope.claim(frame, "report");
    ctx.emit(FEED_POST_EVENT, {
      ...feedPayload(
        {
          ...(entry.body === undefined ? {} : { body: entry.body }),
          key: entry.key ?? `${kind}:${occurrence}`,
          kind,
          ...(entry.media === undefined ? {} : { media: entry.media }),
          title: entry.title,
        },
        root
      ),
      ...(artifact === undefined ? {} : { artifact }),
    });
  };
  return {
    async artifact(
      definition: ArtifactDefinition,
      files: ArtifactFiles,
      entry?: Partial<ReportEntry>
    ) {
      const version = await context().artifacts.write(definition, files);
      post(
        "result",
        { ...entry, title: entry?.title ?? definition.name },
        { artifactId: version.artifactId, contentId: version.contentId }
      );
      return version;
    },
    milestone: (entry) => post("milestone", entry),
    result: (entry) => post("result", entry),
  };
}

export interface ContextArgs<I> {
  readonly bindings: Bindings;
  readonly ctx: StepContext;
  readonly cwd: string;
  readonly frame: Frame;
  readonly input: I;
  readonly scope: RunScope;
}

export function buildContext<I>({
  bindings,
  ctx,
  cwd,
  frame,
  input,
  scope,
}: ContextArgs<I>): Context<I> {
  const write = (value: unknown) => ctx.write(value);
  const managerArgs = { cwd, frame, scope, write };
  const run: Run = {
    abort: (reason) => scope.abort(reason),
    id: scope.id,
    path: ctx.path,
    session: scope.session,
    signal: scope.signal,
    get stream() {
      return scope.stream();
    },
  };
  const log = createLog((level, message) => {
    ctx.step.log(level, message);
    bindings.log[level](message);
  });
  const askArgs = { ctx, frame, scope };
  let built: Context<I> | undefined;
  const context: Context<I> = {
    get agents() {
      return bindings.agents(managerArgs);
    },
    get artifacts() {
      return bindings.artifacts(managerArgs);
    },
    ask: buildAsk(askArgs),
    input,
    log,
    report: buildReport({
      ...askArgs,
      context: () => built as Context<unknown>,
      root: bindings.root,
    }),
    run,
    get sandboxes() {
      return bindings.sandboxes(managerArgs);
    },
    signal: frame.signal,
    stream: {
      pipe: (source) => ctx.pipe(source),
      write,
    },
    get workspaces() {
      return bindings.workspaces(managerArgs);
    },
  };
  built = context;
  return context;
}
