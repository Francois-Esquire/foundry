import { useEffect, useState } from "react";
import { loadAtlas } from "../load-atlas";
import type { AtlasData } from "../types";
import Atlas from "./atlas-view";

export function App() {
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
        mapOnly={
          new URLSearchParams(window.location.search).get("view") === "map"
        }
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
