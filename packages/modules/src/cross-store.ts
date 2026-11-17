import type { Artifacts } from "@foundry/artifacts";

import { ModuleCrossStoreError } from "./errors";

export async function assertOwnsArtifactCommit(
  artifacts: Pick<Artifacts, "transaction">,
  operation: string
): Promise<void> {
  let committed = false;
  await artifacts.transaction((_artifacts, effects) => {
    effects.afterCommit(() => {
      committed = true;
      return Promise.resolve();
    });
    return Promise.resolve();
  });
  if (!committed) {
    throw new ModuleCrossStoreError(
      `${operation} was called inside an Artifact transaction; it commits its Artifact before the registry, so it must own that commit. Call it outside the transaction.`
    );
  }
}
