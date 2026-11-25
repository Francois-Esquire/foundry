import type { ArtifactSubstrate } from "@foundry/artifacts";
import { ReentrantCallError } from "@foundry/lib/turns";

import { ModuleCrossStoreError } from "./errors";

export async function assertOwnsArtifactCommit(
  artifacts: Pick<ArtifactSubstrate, "transaction">,
  operation: string
): Promise<void> {
  let committed = false;
  try {
    await artifacts.transaction((_artifacts, effects) => {
      effects.afterCommit(() => {
        committed = true;
        return Promise.resolve();
      });
      return Promise.resolve();
    });
  } catch (error) {
    if (error instanceof ReentrantCallError) {
      throw new ModuleCrossStoreError(
        `${operation} was called inside an Artifact transaction; it commits its Artifact before the registry, so it must own that commit. Call it outside the transaction.`,
        { cause: error }
      );
    }
    throw error;
  }
  if (!committed) {
    throw new ModuleCrossStoreError(
      `${operation} was called inside an Artifact transaction; it commits its Artifact before the registry, so it must own that commit. Call it outside the transaction.`
    );
  }
}
