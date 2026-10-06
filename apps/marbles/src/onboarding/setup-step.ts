import { basename } from "node:path";
import type { StepContext } from "@foundry/workflows/step";
import { Step } from "@foundry/workflows/step";

import type { Engine } from "~/lib/engine";
import { FEED_POST_EVENT, feedPayload } from "~/lib/feed/entry";
import { type SetupDraft, STARTERS } from "~/onboarding/templates";

/** Built in rather than registered from a config, so it stays out of the catalog. */
export const SETUP_STEP = "marbles.workspace-setup";

export interface SetupInput {
  readonly configPath: string;
  readonly draft: SetupDraft;
  readonly root: string;
}

/**
 * Onboarding's milestone. Posting happens in a real step, like every entry,
 * so it carries a Run and appears in the Runs panel beside it.
 */
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
  engine.register(SETUP_STEP, new WorkspaceSetupStep().factory());
}

function setupArticle({ configPath, draft, root }: SetupInput): string {
  const starter = STARTERS.find((item) => item.id === draft.template);
  const harness = draft.harness === "auto" ? "first detected" : draft.harness;
  return [
    `Marbles now runs in \`${root}\`.`,
    "",
    `- **Source:** \`${basename(configPath)}\``,
    `- **Starter:** ${starter ? `${starter.label}: ${starter.description}` : draft.template}`,
    `- **First step:** \`${draft.name}\``,
    `- **Harness:** ${harness}`,
    "",
    `Launch \`${draft.name}\` from Marbles on the Dashboard tab. Steps that call \`report\` publish here.`,
  ].join("\n");
}
