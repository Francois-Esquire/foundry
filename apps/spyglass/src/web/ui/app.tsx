import { useEffect, useState } from "react";
import type { SpyglassData } from "../data/types";
import {
  type LateReadings,
  loadLateReadings,
  loadSpyglass,
} from "../layout/load-spyglass";
import { afterFirstFrame } from "../timings";
import Spyglass from "./spyglass-view";

/** Page options; developer instrumentation is enabled only by Vite's compile-time flag. */
export function readSession(search = window.location.search) {
  const params = new URLSearchParams(search);
  return {
    developer: import.meta.env.DEV,
    mapOnly: params.get("view") === "map",
    study: import.meta.env.DEV && params.get("scene") === "harbor",
  };
}

export function App() {
  const [session] = useState(() => readSession());
  const [data, setData] = useState<SpyglassData>();
  const [late, setLate] = useState<Promise<LateReadings>>();
  const [error, setError] = useState<string>();
  const [waiting, setWaiting] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    const fail = (cause: unknown) => {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error ? cause.message : "Spyglass could not load."
        );
      }
    };
    const load = async () => {
      try {
        if (import.meta.env.DEV && session.study) {
          const { renderingStudy } = await import("../layout/rendering-study");
          if (!controller.signal.aborted) {
            setData(renderingStudy());
          }
          return;
        }
        // A collection's server answers 503 while a workspace's dataset is
        // swapped; the load waits, and says why.
        const spyglass = await loadSpyglass(controller.signal, setWaiting);
        // Read beside the scene's build and merged after its first frame,
        // so neither the read nor the re-render it causes delays it; a
        // refusal fails the page as a refusal at load does.
        const read = loadLateReadings(spyglass, controller.signal);
        read.catch(fail);
        setLate(
          Promise.all([read, afterFirstFrame()]).then(([readings]) => readings)
        );
        setData(spyglass);
      } catch (cause) {
        fail(cause);
      }
    };
    load();
    return () => controller.abort();
  }, [session.study]);

  if (data && !error) {
    return (
      <Spyglass
        data={data}
        developer={session.developer}
        late={late}
        mapOnly={session.mapOnly}
        readInternals={!session.study}
      />
    );
  }
  return (
    <main style={{ padding: "8vw" }}>
      <h1>Spyglass</h1>
      {error ? <p role="status">{error}</p> : null}
      {error ? null : (
        <p role="status">
          {waiting
            ? `Waiting for a workspace's dataset: ${waiting}`
            : "Loading workspace…"}
        </p>
      )}
    </main>
  );
}
