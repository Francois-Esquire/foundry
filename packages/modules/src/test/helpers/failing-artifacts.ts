import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";

/**
 * Artifacts over an in-memory store whose writing transactions fail just
 * before they would commit while `fail` holds, so nothing they did stays:
 * the case a cross-store operation must survive and a retry must finish.
 */
export function failingArtifacts(): {
  readonly artifacts: ArtifactManager;
  fail: boolean;
} {
  const base = new InMemoryArtifactStore();
  const control: { artifacts: ArtifactManager; fail: boolean } = {
    artifacts: new ArtifactManager({
      store: {
        transaction: (operation, options) =>
          base.transaction(async (view) => {
            const result = await operation(view);
            if (control.fail && options?.readOnly !== true) {
              throw new Error("simulated Artifact commit failure");
            }
            return result;
          }, options),
      },
    }),
    fail: true,
  };
  return control;
}
