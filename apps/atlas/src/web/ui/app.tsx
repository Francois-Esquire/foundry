import { useEffect, useState } from "react";
import { loadAtlas } from "../load-atlas";
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
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        setData(await loadAtlas(controller.signal));
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error ? cause.message : "Atlas could not load."
          );
        }
      }
    };
    load();
    return () => controller.abort();
  }, []);

  if (data) {
    return (
      <Atlas
        data={data}
        developer={session.developer}
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
