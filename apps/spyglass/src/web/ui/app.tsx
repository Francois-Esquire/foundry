import { useEffect, useState } from "react";
import type { SpyglassData } from "../data/types";
import {
  type LateReadings,
  loadLateReadings,
  loadSpyglass,
} from "../layout/load-spyglass";
import { afterFirstFrame } from "../timings";
import Spyglass from "./spyglass-view";

export function readSession(search = window.location.search) {
  const params = new URLSearchParams(search);
  return {
    developer: import.meta.env.DEV,
    mapOnly: params.get("view") === "map",
  };
}

export function App() {
  const [session] = useState(() => readSession());
  const [data, setData] = useState<SpyglassData>();
  const [late, setLate] = useState<Promise<LateReadings>>();
  const [error, setError] = useState<string>();
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
        const spyglass = await loadSpyglass(controller.signal);
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
  }, []);

  if (data && !error) {
    return (
      <Spyglass
        data={data}
        developer={session.developer}
        late={late}
        mapOnly={session.mapOnly}
      />
    );
  }
  return (
    <main style={{ padding: "8vw" }}>
      <h1>Spyglass</h1>
      {error ? <p role="status">{error}</p> : null}
      {error ? null : <p role="status">Loading workspace…</p>}
    </main>
  );
}
