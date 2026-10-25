import { Suspense } from "react";
import {
  type AppBarContext,
  type AppBarEntry,
  appBarEntries,
} from "./chrome-entries";
import { CompassRose } from "./compass-control";

/** The narrow bar grows left from the compass, then scrolls within the viewport. */
export function ChartAppBar({
  context,
  open,
  entries = appBarEntries,
}: {
  context: AppBarContext;
  open: boolean;
  entries?: readonly AppBarEntry[];
}) {
  return (
    <div className="spyglass-app-bar">
      <nav aria-label="Map controls" className="spyglass-app-bar-items">
        {entries.map(({ id, component: Item }) => (
          <div className="spyglass-app-bar-item" key={id}>
            <Suspense fallback={null}>
              <Item {...context} />
            </Suspense>
          </div>
        ))}
      </nav>
      <button
        aria-controls="spyglass-sidebar"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Open chart controls"
        className="spyglass-compass-control"
        onClick={context.onOpen}
        title="Chart settings"
        type="button"
      >
        <CompassRose />
      </button>
    </div>
  );
}
