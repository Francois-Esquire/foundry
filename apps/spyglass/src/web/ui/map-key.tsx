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
        their towns stand where the files are. Connected packages draw together.
      </p>
      {foundations && (
        <p>
          <strong>Shallow banks are shared dependencies.</strong> Islands that
          rely on the same runtime dependencies stand on one bank.
        </p>
      )}
      <p className="spyglass-map-key-note">
        Water shading follows distance from shore and the banks&apos; depth.
      </p>
      {selection && (
        <p className="spyglass-map-key-note">
          The selected island is outlined; Escape returns to the whole map.
        </p>
      )}
    </section>
  );
}
