import type { SpyglassState } from "./spyglass-state";

type LegendState = Pick<SpyglassState, "data" | "selection">;

/** The legend explains what the map draws without becoming another control panel. */
export function MapKey({ state }: { state: LegendState }) {
  const { selection } = state;
  const foundations = !!state.data.foundations?.length;
  return (
    <section aria-label="Map legend" className="spyglass-map-key">
      <h2>Reading this map</h2>
      <p>
        <strong>Islands are packages.</strong> Their files shape the land, and
        each building in their towns is a file. Connected packages draw
        together. Zoom in to see each island&apos;s file count under its name.
      </p>
      {foundations && (
        <p>
          <strong>Shallow banks are shared dependencies.</strong> Islands that
          rely on the same runtime dependencies stand on one bank. Choose a bank
          to see which islands share it.
        </p>
      )}
      <p className="spyglass-map-key-note">
        The sea is shallow near the coast and deepens away from it; the banks
        rise from the deep in terraces.
      </p>
      {selection && (
        <p className="spyglass-map-key-note">
          The chosen island or bank is lit; Escape returns to the whole map.
        </p>
      )}
    </section>
  );
}
