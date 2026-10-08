import { AsyncIteratorClass } from "@orpc/server";
import type { ModuleAppEvent } from "~/shared/modules";
import type { ModuleBuilds } from "./builds/controller";
import type { ModuleLibrary } from "./library";
import type { ModuleSessions } from "./runtime/controller";

/** Opening a module owns its build/start lifetime; closing it stops its VM. */
export function openModuleApp(
  library: ModuleLibrary,
  builds: ModuleBuilds,
  sessions: ModuleSessions,
  id: string,
  signal?: AbortSignal
) {
  const cancel = new AbortController();
  const lifetime = AbortSignal.any([
    cancel.signal,
    ...(signal ? [signal] : []),
  ]);
  async function* launch(): AsyncGenerator<ModuleAppEvent, void> {
    try {
      const details = await library.details(id);
      if (!details) {
        throw new Error("Module not found");
      }
      let contentId = details.releases[0]?.contentId;
      if (!contentId) {
        contentId = yield* buildFirstRelease(library, builds, id, lifetime);
      }
      lifetime.throwIfAborted();
      yield { phase: "starting" };
      for await (const app of sessions.watch(id, contentId, lifetime)) {
        yield { app, phase: "ready" };
      }
    } catch (error) {
      if (!lifetime.aborted) {
        yield {
          message:
            error instanceof Error ? error.message : "Module could not open",
          phase: "failed",
        };
      }
    }
  }
  const iterator = launch();
  return new AsyncIteratorClass<ModuleAppEvent, void>(
    () => iterator.next(),
    async () => {
      cancel.abort();
      await iterator.return(undefined);
    }
  );
}

async function* buildFirstRelease(
  library: ModuleLibrary,
  builds: ModuleBuilds,
  id: string,
  signal: AbortSignal
): AsyncGenerator<ModuleAppEvent, string> {
  const details = await library.details(id);
  if (!details?.binding) {
    throw new Error("This module has no runnable release or source");
  }
  for await (const event of builds.watch(
    id,
    "0.1.0",
    details.binding,
    signal
  )) {
    if (event.phase === "failed") {
      throw new Error(event.message);
    }
    if (event.phase === "complete") {
      return event.release.contentId;
    }
    yield { phase: "building", step: event.phase };
  }
  throw new Error("Module build did not produce a release");
}
