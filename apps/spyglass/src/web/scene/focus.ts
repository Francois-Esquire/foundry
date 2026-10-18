import { Vector3 } from "three";
import type { SpyglassData } from "../data/types";
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
 * camera flies to the place. Focusing nothing returns to the overview.
 */
export function createFocus(context: {
  camera: Pick<ChartCamera, "flyTo" | "focusZoom">;
  /** The geometry the scene was built from, whose islands a relayout refocuses. */
  data: SpyglassData;
  onTrades?: (routes: TradeRoute[]) => void;
  state: ViewState;
  trade: ReturnType<typeof createTradeChart>;
  tradeLayer: { setRoutes: (routes: TradeRoute[]) => void };
}) {
  const { camera, onTrades, state, trade, tradeLayer } = context;
  const setTrades = (selected: string | null) => {
    state.trades = trade.trades(selected);
    tradeLayer.setRoutes(trade.seaTrades(state.trades));
    onTrades?.(state.trades);
  };
  setTrades(null);
  const focus: SpyglassScene["focus"] = (
    initialTerritory,
    initialFile,
    fileIds
  ) => {
    const territory = initialTerritory
      ? (state.drawingData.territories.find(
          (item) => item.id === initialTerritory.id
        ) ?? initialTerritory)
      : null;
    const file = initialFile
      ? territory?.files.find((item) => item.id === initialFile.id)
      : undefined;
    state.selected = territory?.id ?? null;
    setTrades(state.selected);
    state.selectedFile = file?.id ?? null;
    const bounds = territory
      ? frameFiles(
          territory.files.filter((f) => !fileIds || fileIds.includes(f.id))
        )
      : null;
    camera.flyTo({
      target: new Vector3(
        (territory?.x ?? 0) + (file?.x ?? bounds?.x ?? 0),
        -(territory?.y ?? 0) - (file?.y ?? bounds?.y ?? 0),
        0
      ),
      zoom: camera.focusZoom({ bounds, file, fileIds, territory }),
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
