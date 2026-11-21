export type LiveWork =
  | {
      readonly agent?: string;
      readonly id: string;
      readonly input: "steer";
      readonly kind: "agent";
      readonly model?: string;
      readonly provider?: string;
      readonly sessionId: string;
      readonly stepId: string;
    }
  | {
      readonly command: string;
      readonly id: string;
      readonly input: "stdin" | "none";
      readonly kind: "command";
      readonly pid?: number;
      readonly stepId: string;
    };

export type StartedWork =
  | {
      readonly agent?: string;
      readonly kind: "agent";
      readonly model?: string;
      readonly provider?: string;
      readonly sessionId: string;
      steer(prompt: string): void;
    }
  | {
      readonly command: string;
      readonly kind: "command";
      readonly pid?: number;
      readonly stdin?: (line: string) => void;
    };

export interface StepInput {
  readonly target: string;
  readonly text: string;
}

export type StepInputFailure =
  | "ambiguous"
  | "no-agent"
  | "no-input"
  | "not-live";

export class StepInputError extends Error {
  readonly code: StepInputFailure;
  override readonly name = "StepInputError";

  constructor(code: StepInputFailure, message: string) {
    super(message);
    this.code = code;
  }
}

interface Entry {
  readonly deliver?: (text: string) => void;
  readonly work: LiveWork;
}

function described(id: string, stepId: string, started: StartedWork): Entry {
  if (started.kind === "agent") {
    const { steer, ...rest } = started;
    return { deliver: steer, work: { ...rest, id, input: "steer", stepId } };
  }
  const { stdin, ...rest } = started;
  return {
    ...(stdin === undefined ? {} : { deliver: stdin }),
    work: { ...rest, id, input: stdin ? "stdin" : "none", stepId },
  };
}

export class StepWork {
  readonly #live = new Map<string, Entry>();
  readonly #stepId: string;

  constructor(stepId: string) {
    this.#stepId = stepId;
  }

  begin(started: StartedWork): () => void {
    const id = crypto.randomUUID();
    this.#live.set(id, described(id, this.#stepId, started));
    return () => {
      this.#live.delete(id);
    };
  }

  list(): readonly LiveWork[] {
    return [...this.#live.values()].map((entry) => entry.work);
  }

  send({ target, text }: StepInput): void {
    const entry = this.#live.get(target);
    if (!entry) {
      throw new StepInputError(
        "not-live",
        `That work is no longer live in "${this.#stepId}"; it ended, or it runs in another step or run.`
      );
    }
    if (!entry.deliver) {
      throw new StepInputError(
        "no-input",
        `This ${entry.work.kind} in "${this.#stepId}" cannot take input; its output is shown only.`
      );
    }
    entry.deliver(text);
  }

  steer(prompt: string): void {
    const turns = [...this.#live.values()].filter(
      (entry) => entry.work.kind === "agent"
    );
    const [only] = turns;
    if (!only) {
      throw StepWork.noTurn(this.#stepId);
    }
    if (turns.length > 1) {
      throw new StepInputError(
        "ambiguous",
        `${String(turns.length)} agent turns are running in "${this.#stepId}"; choose which one to steer.`
      );
    }
    this.send({ target: only.work.id, text: prompt });
  }

  static noTurn(stepId: string): StepInputError {
    return new StepInputError(
      "no-agent",
      `no agent turn is running in "${stepId}"`
    );
  }
}
