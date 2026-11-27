import type { ArtifactSubstrate } from "@foundry/artifacts";
import { ReentrantCallError } from "@foundry/lib/turns";

export class ModuleCrossStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleCrossStoreError";
  }
}

export async function assertOwnsArtifactCommit(
  artifacts: Pick<ArtifactSubstrate, "durability" | "transaction">,
  operation: string
): Promise<void> {
  if (artifacts.durability === "host") {
    throw new ModuleCrossStoreError(
      `${operation} was called over an Artifact store whose commits a host transaction may roll back; it commits its Artifact before the registry, so it must own that commit. Call it outside the host transaction.`
    );
  }
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
