import type { Artifacts } from "@foundry/artifacts";

import { ModuleCrossStoreError } from "./errors";

/**
 * Refuses, before anything is written, an operation that writes both the
 * Artifacts and the registry when it is called inside a caller's Artifact
 * transaction.
 *
 * Such an operation commits its Artifact step first and its registry step
 * second, and relies on the first having committed when it returns. Inside
 * a caller's transaction it would not have: `ArtifactManager.transaction`
 * joins the open one, so the Artifact write commits only with the caller's,
 * after the registry's, and a rollback there leaves the registry naming an
 * Artifact that does not exist.
 *
 * The manager offers no way to ask whether a transaction is open, so this
 * asks by effect: an empty transaction whose `afterCommit` marks that it
 * ran. A transaction of its own commits, and runs that effect, before it
 * returns; a joined one registers the effect with the caller's transaction,
 * which has not committed yet. The probe writes nothing and throws nothing,
 * so it never fails or changes a caller's transaction.
 */
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
