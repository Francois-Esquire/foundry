import { ArtifactManager } from "@foundry/artifacts";
import { InMemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { interceptCommits } from "@foundry/artifacts/testing";

export function failingArtifacts(): {
  readonly artifacts: ArtifactManager;
  fail: boolean;
} {
  const control: { fail: boolean } = { fail: true };
  const store = interceptCommits(
    new InMemoryArtifactStore(),
    (write, commit) =>
      control.fail
        ? Promise.reject(new Error("simulated Artifact commit failure"))
        : commit(write)
  );
  return Object.assign(control, {
    artifacts: new ArtifactManager({ store }),
  });
}
