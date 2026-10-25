import { Vector3 } from "three";
import type { createTradeChart } from "../layout/trade-chart";
import type { TradeRoute } from "../layout/trade-routes";
import { frameFiles } from "../view/chart-view";
import type { ChartCamera } from "./chart-camera";
import type { SpyglassScene } from "./handle";
import type { ViewState } from "./view-state";

/** The zoom a wreck is visited at. */
const wreckZoom = 8;

/**
 * What a selection does to the chart: the island and file it names become
 * the view state's, the trades become the island's leading trades, and the
 * camera flies to the place. Focusing nothing returns to the overview. The
 * ids are resolved on the island as drawn, so a relayout's focus lands on
 * the file where it now lies.
 */
export function createFocus(context: {
  camera: Pick<ChartCamera, "flyTo" | "focus">;
  onTrades?: (routes: TradeRoute[]) => void;
  state: ViewState;
  trade: ReturnType<typeof createTradeChart>;
  tradeLayer: { setRoutes: (routes: TradeRoute[]) => void };
}) {
  const { camera, onTrades, state, trade, tradeLayer } = context;
  const setTrades = (selected: string | null) => {
    const trades = trade.trades(selected);
    tradeLayer.setRoutes(trade.seaTrades(trades));
    onTrades?.(trades);
  };
  setTrades(null);
  const focus: SpyglassScene["focus"] = (selection) => {
    const territory = selection
      ? (state.drawingData.territories.find(
          (item) => item.id === selection.territoryId
        ) ?? null)
      : null;
    const file = selection?.fileId
      ? territory?.files.find((item) => item.id === selection.fileId)
      : undefined;
    state.selected = territory?.id ?? null;
    setTrades(state.selected);
    state.selectedFile = file?.id ?? null;
    // An island is framed on its files' bounds, not its origin.
    const bounds = territory ? frameFiles(territory.files) : null;
    camera.focus({
      file,
      target: new Vector3(
        (territory?.x ?? 0) + (file?.x ?? bounds?.x ?? 0),
        -(territory?.y ?? 0) - (file?.y ?? bounds?.y ?? 0),
        0
      ),
      territory,
    });
  };
  return {
    focus,
    focusWreck: (wreck: { x: number; y: number }) => {
      camera.flyTo({
        target: new Vector3(wreck.x, -wreck.y, 0),
        zoom: wreckZoom,
      });
    },
  };
}
