import { useEffect, useState } from "react";

export function App() {
  const [manifest, setManifest] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/data/manifest.json", {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "No generated output yet. Analysis is not connected in this scaffold."
              : "The manifest could not be loaded."
          );
        }
        setManifest(await response.text());
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

  // Mount the renderer here when it arrives, consuming the library's own data shapes.
  return (
    <main>
      <h1>Atlas</h1>
      {error ? <p role="status">{error}</p> : null}
      {manifest === undefined && !error ? (
        <p role="status">Loading manifest…</p>
      ) : null}
      {manifest === undefined ? null : <pre>{manifest}</pre>}
    </main>
  );
}
