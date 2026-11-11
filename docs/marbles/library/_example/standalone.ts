import {
  ArtifactManager,
  Engine,
  InMemoryArtifactStore,
  InMemorySessionStore,
  ModelManager,
} from "@foundry.sh/marbles/lib";
import { count } from "./count";

export interface CountResult {
  readonly extension: string;
  readonly files: number;
}

/** Runs the `count` step in this process: no CLI, daemon, or agent. */
export async function countFiles(
  root: string,
  extension: string
): Promise<CountResult> {
  const engine = new Engine({
    artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
    askable: false,
    containers: () => Promise.reject(new Error("no sandbox runtime here")),
    models: new ModelManager(),
    root,
    sessions: new InMemorySessionStore(),
    workspaceId: "count-example",
  });
  engine.define(count);
  try {
    await engine.start();
    return await engine.run<CountResult>("count", { extension });
  } finally {
    try {
      await engine.stop();
    } finally {
      await engine.dispose();
    }
  }
}
