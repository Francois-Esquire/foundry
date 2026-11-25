import {
  Artifacts,
  Engine,
  MemoryArtifactStore,
  MemorySessionStore,
  Models,
} from "@foundry.sh/marbles/lib";
import { count } from "./count";

export interface CountResult {
  readonly extension: string;
  readonly files: number;
}

export async function countFiles(
  root: string,
  extension: string
): Promise<CountResult> {
  const engine = new Engine({
    artifacts: new Artifacts({ store: new MemoryArtifactStore() }),
    askable: false,
    containers: () => Promise.reject(new Error("no sandbox runtime here")),
    models: new Models(),
    root,
    sessions: new MemorySessionStore(),
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
