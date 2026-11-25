import { Artifacts } from "@foundry/artifacts";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { interceptCommits } from "@foundry/artifacts/testing";

export function failingArtifacts(): {
  readonly artifacts: Artifacts;
  fail: boolean;
} {
  const control: { fail: boolean } = { fail: true };
  const store = interceptCommits(new MemoryArtifactStore(), (write, commit) =>
    control.fail
      ? Promise.reject(new Error("simulated Artifact commit failure"))
      : commit(write)
  );
  return Object.assign(control, {
    artifacts: new Artifacts({ store }),
  });
}
