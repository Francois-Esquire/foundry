import assert from "node:assert/strict";
import {
  gatewayBinding,
  ModelManager,
  vercelBinding,
} from "@foundry.sh/marbles/engine";
import { vaultAuthoringModels } from "~/main/modules/authoring/models";
import { openAppVault } from "~/main/vault/safe-storage";
import { runElectronSmoke, waitFor } from "../helpers/electron";
import { smokeWorks } from "../helpers/smoke-works";

const APP = "packages/app/src/App.tsx";
const TEXT = "Edited by a live chat turn.";
const TURN_DEADLINE_MS = 600_000;

/**
 * One real authoring turn against the provider route Works would use: the
 * vault of this smoke's fresh profile (so the user's own vault is never
 * read), which falls back to the environment, as main does. Credentials
 * reach the environment through the repository's Varlock path:
 * `bun run env:run -- bun run --cwd apps/works test:authoring-live`.
 * Without them it reports the skip and passes; values are never printed.
 */
async function smoke(userData: string) {
  const models = new ModelManager({
    bindings: [gatewayBinding, vercelBinding],
  });
  const routes = vaultAuthoringModels(models, await openAppVault(userData));
  let route: ReturnType<typeof routes.route>;
  try {
    route = routes.route();
  } catch {
    process.stdout.write(
      "Electron live authoring skipped: no provider credentials (set a Gateway or Vercel key through Varlock to run it)\n"
    );
    return;
  }
  const works = await smokeWorks(userData, { models, routes });
  try {
    const { authoring, modules } = works.rpc;
    const module = await modules.create("Live chat");
    const details = await modules.details(module.id);
    assert.ok(details?.binding);
    const sent = await authoring.send(module.id, {
      binding: details.binding,
      prompt: `In ${APP}, replace the paragraph's text with "${TEXT}". Change nothing else.`,
      source: details.source,
    });
    let { status } = sent;
    await waitFor(
      async () => {
        const { turns } = await authoring.conversation(module.id);
        const turn = turns.find((candidate) => candidate.id === sent.id);
        status = turn?.status ?? status;
        if (turn?.status === "failed") {
          throw new Error(`The live turn failed: ${turn.error}`);
        }
        return !["queued", "running"].includes(status);
      },
      "The live turn did not finish",
      TURN_DEADLINE_MS
    );
    assert.equal(status, "complete");
    const { proposal } = await authoring.proposal(module.id, sent.id);
    assert.ok(proposal[APP]?.includes(TEXT), "The proposal lacks the edit");
    process.stdout.write(
      `Electron live authoring passed (${route.provider}/${route.model}): proposal changes ${Object.keys(proposal).join(", ")}\n`
    );
  } finally {
    await works.close();
  }
}

runElectronSmoke("live authoring", smoke);
