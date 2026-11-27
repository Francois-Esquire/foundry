import { basename } from "node:path";
import type { StepContext } from "@foundry/workflows/step";
import { Step } from "@foundry/workflows/step";

import type { Engine } from "~/lib/engine";
import { FEED_POST_EVENT, feedPayload } from "~/lib/feed/entry";
import { type SetupDraft, STARTER, STARTER_GUIDE } from "~/workspace/templates";

export const SETUP_STEP = "marbles.workspace-setup";

export interface SetupInput {
  readonly configPath: string;
  readonly draft: SetupDraft;
  readonly root: string;
}

class WorkspaceSetupStep extends Step<SetupInput, void> {
  readonly definitionKey = SETUP_STEP;
  declare readonly name: string;

  constructor() {
    super();
    this.name = SETUP_STEP;
  }

  protected execute(
    input: SetupInput,
    context: StepContext<SetupInput, void>
  ): Promise<void> {
    context.emit(
      FEED_POST_EVENT,
      feedPayload(
        {
          body: setupArticle(input),
          key: "workspace-set-up",
          kind: "milestone",
          title: `Workspace set up: ${basename(input.root)}`,
        },
        input.root
      )
    );
    return Promise.resolve();
  }
}

export function registerSetupStep(engine: Engine): void {
  const factory = new WorkspaceSetupStep().factory();
  engine.register(SETUP_STEP, (input: SetupInput) => factory(input));
}

function setupArticle({ configPath, draft, root }: SetupInput): string {
  return [
    `Marbles now runs in \`${root}\`.`,
    "",
    `- **Source:** \`${basename(configPath)}\``,
    `- **First step:** \`${draft.name}\` (${STARTER.description})`,
    `- **Guide:** ${STARTER_GUIDE}`,
    "",
    `Launch \`${draft.name}\` from Marbles on the Dashboard tab. Steps that call \`report\` publish here.`,
  ].join("\n");
}
