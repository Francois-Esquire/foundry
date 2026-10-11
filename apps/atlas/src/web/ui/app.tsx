import { useEffect, useState } from "react";
import type { LateCodex } from "../codex/vocabulary";
import { loadAtlas, loadLateReadings } from "../load-atlas";
import { afterFirstFrame } from "../timings";
import type { AtlasData } from "../types";
import Atlas from "./atlas-view";

/**
 * Read once from the page's address: `?view=map` shows the map alone, and
 * `?dev` (or the Vite dev server) opens a developer session, with paint
 * timings (renderer controls follow in 4.1).
 */
export function readSession(search = window.location.search) {
  const params = new URLSearchParams(search);
  return {
    developer: import.meta.env.DEV || params.has("dev"),
    mapOnly: params.get("view") === "map",
  };
}

export function App() {
  const [session] = useState(() => readSession());
  const [data, setData] = useState<AtlasData>();
  const [late, setLate] = useState<Promise<LateCodex>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    const fail = (cause: unknown) => {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error ? cause.message : "Atlas could not load."
        );
      }
    };
    const load = async () => {
      try {
        const atlas = await loadAtlas(controller.signal);
        // Read beside the scene's build and merged after its first frame,
        // so neither the read nor the re-render it causes delays it; a
        // refusal fails the page as a refusal at load does.
        const read = loadLateReadings(atlas, controller.signal);
        read.catch(fail);
        setLate(
          Promise.all([read, afterFirstFrame()]).then(([readings]) => readings)
        );
        setData(atlas);
      } catch (cause) {
        fail(cause);
      }
    };
    load();
    return () => controller.abort();
  }, []);

  if (data && !error) {
    return (
      <Atlas
        data={data}
        developer={session.developer}
        late={late}
        mapOnly={session.mapOnly}
      />
    );
  }
  return (
    <main style={{ padding: "8vw" }}>
      <h1>Atlas</h1>
      {error ? <p role="status">{error}</p> : null}
      {error ? null : <p role="status">Loading workspace…</p>}
    </main>
  );
}
