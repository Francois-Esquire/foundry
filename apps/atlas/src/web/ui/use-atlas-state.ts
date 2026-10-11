import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BelongingLayer } from "../belonging";
import { type BelongingRegion, belongingAncestry } from "../belonging";
import type { ChartSettings } from "../chart-settings";
import type { DomainRef } from "../domain-extent";
import { relayoutAtlas } from "../geography";
import type { AtlasInternals } from "../internals";
import type { LateReadings } from "../load-atlas";
import type { NaturalFeatures } from "../natural-features";
import type { ResponsibilityOverlay } from "../responsibility-focus";
import type { AtlasSelection } from "../scene/scene";
import type { TradeRoute } from "../trade-routes";
import {
  type AtlasData,
  type AtlasFile,
  type AtlasSymbol,
  type FormerPackage,
  islandSource,
  type Territory,
} from "../types";
import type { AtlasMapHandle } from "./atlas-map";
import {
  type AtlasState,
  createAtlasState,
  type MapLayer,
} from "./atlas-state";

import { useBelonging } from "./use-belonging";

function canonicalSelection(data: AtlasData, value: AtlasSelection | null) {
  if (!value) {
    return null;
  }
  const territory =
    data.territories.find((item) => item.id === value.territory.id) ??
    value.territory;
  return {
    ...value,
    file: territory.files.find((file) => file.id === value.file?.id),
    territory,
  };
}

export function useAtlasState(
  initial: AtlasState,
  late?: Promise<LateReadings>,
  imports?: () => Promise<AtlasData["fileEdges"]>
) {
  const sourceData = initial.data;
  const [layoutSettings, setLayoutSettings] = useState(initial.layoutSettings);
  const geometry = useMemo(
    () =>
      layoutSettings === initial.layoutSettings
        ? sourceData
        : relayoutAtlas(sourceData, layoutSettings.islandClearance),
    [sourceData, layoutSettings, initial.layoutSettings]
  );
  // The late readings join after the relayout, so their arrival keeps the
  // islands and the scene is not rebuilt.
  const readings = useLateReadings(late);
  const traced = useImports(imports);
  const { edges } = traced;
  const data = useMemo(() => {
    const read = readings ? withLateReadings(geometry, readings) : geometry;
    return edges ? { ...read, fileEdges: edges } : read;
  }, [geometry, readings, edges]);
  const scene = useRef<AtlasMapHandle | null>(null);
  const [chosen, setSelection] = useState<AtlasSelection | null>(
    initial.selection
  );
  const [trades, setTrades] = useState<TradeRoute[]>(initial.trades);
  const [hover, setHover] = useState<AtlasSelection | null>(initial.hover);
  const [selectedWreck, setSelectedWreck] = useState<FormerPackage | null>(
    initial.selectedWreck
  );
  const [hoveredWreck, setHoveredWreck] = useState<FormerPackage | null>(
    initial.hoveredWreck
  );
  const [mapLayer, setMapLayer] = useState<MapLayer>(initial.mapLayer);
  const [domain, setDomain] = useState<DomainRef | null>(initial.domain);
  const [legendHeight, setLegendHeight] = useState(initial.legendHeight);
  const [tracedSelection, setTracedSelection] = useState<AtlasSelection | null>(
    null
  );
  const [responsibilityOverlay, setResponsibilityOverlay] =
    useState<ResponsibilityOverlay | null>(initial.responsibility);
  const [territoryLayout, setTerritoryLayout] = useState<Territory | null>(
    initial.territoryLayout
  );
  const [viewTerritory, setViewTerritory] = useState<Territory | null>(null);
  const [chartSettings, setChartSettings] = useState(initial.chartSettings);
  const chartPreference = useRef(chartSettings);
  const { coastalBuffer, islandClearance } = chartSettings;
  const territory = chosen?.territory;
  const viewBelonging = useBelonging(
    viewTerritory ?? undefined,
    viewTerritory ? islandSource(data, viewTerritory.id) : undefined,
    chartSettings.volcanic,
    chartSettings.streams
  );
  const selectedBelonging = useBelonging(
    resolveSelectedBelonging(
      territory,
      viewTerritory,
      viewBelonging,
      territoryLayout
    ),
    territory ? islandSource(data, territory.id) : undefined,
    chartSettings.volcanic,
    chartSettings.streams
  );
  const belonging =
    territory?.id === viewTerritory?.id && viewBelonging.data
      ? viewBelonging
      : selectedBelonging;
  const selection = useMemo(
    () =>
      chosen
        ? {
            ...chosen,
            ...belongingAncestry(belonging.regions, belonging.composites, {
              compositeId: chosen.compositeId,
              fileId: chosen.file?.id,
              regionId: chosen.regionId,
            }),
          }
        : null,
    [chosen, belonging.regions, belonging.composites]
  );
  const showConnections = selection !== null && tracedSelection === selection;
  const select = useCallback(
    (initialValue: AtlasSelection | null) => {
      let value = initialValue;
      setSelectedWreck(null);
      value = canonicalSelection(data, value);
      value = selectionAncestry(value, territory, belonging, selection);
      setSelection(value);
      setHover(null);
      if (value?.regionId || value?.compositeId) {
        scene.current?.pinRegion();
      }
      if (!value?.symbol && value?.file) {
        scene.current?.focus(value.territory, value.file);
      } else if (
        !(
          value?.feature ||
          value?.symbol ||
          value?.regionId ||
          value?.compositeId
        )
      ) {
        scene.current?.focus(value?.territory ?? null, value?.file);
      }
    },
    [
      belonging,
      data,
      scene,
      selection,
      setHover,
      setSelectedWreck,
      setSelection,
      territory,
    ]
  );
  const selectRef = useRef(select);
  const selectionRef = useRef(selection);
  const domainRef = useRef(domain);
  useEffect(() => {
    selectRef.current = select;
    selectionRef.current = selection;
    domainRef.current = domain;
  });
  useEffect(() => {
    if (
      coastalBuffer === layoutSettings.coastalBuffer &&
      islandClearance === layoutSettings.islandClearance
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      setSelection(null);
      setHover(null);
      setTerritoryLayout(null);
      setResponsibilityOverlay(null);
      setTracedSelection(null);
      setLayoutSettings({ coastalBuffer, islandClearance });
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [coastalBuffer, islandClearance, layoutSettings]);
  const selectedRegion = belonging.regions.find(
    (region) => region.id === selection?.regionId
  );
  const selectedComposite = belonging.composites.find(
    (region) => region.id === selection?.compositeId
  );
  const viewIsSelected =
    viewTerritory !== null && viewTerritory.id === territory?.id;
  const mapBelonging = viewIsSelected ? belonging : viewBelonging;
  const belongingLayer = useMemo(
    () =>
      resolveValue(
        viewTerritory,
        mapLayer,
        viewIsSelected,
        selectedRegion,
        selectedComposite,
        selection,
        mapBelonging,
        belonging,
        territoryLayout
      ),
    [
      viewTerritory,
      mapLayer,
      viewIsSelected,
      selectedRegion,
      selectedComposite,
      selection,
      mapBelonging.regions,
      mapBelonging.composites,
      mapBelonging.features,
      belonging.composites,
      territoryLayout,
    ]
  );
  const frameSelection = useCallback(
    (ids: string[]) => {
      if (territory) {
        scene.current?.focus(territory, undefined, ids);
      }
    },
    [scene, territory]
  );
  const changeMapLayer = useCallback(
    (value: MapLayer) => {
      setMapLayer(value);
      if ((selection?.regionId || selection?.compositeId) && territory) {
        select({ territory });
      }
    },
    [select, selection, setMapLayer, territory]
  );
  const { read: readImports } = traced;
  const toggleTrace = useCallback(() => {
    if (!showConnections) {
      // The first trace reads every import edge; the trace draws once they arrive.
      readImports();
    }
    setTracedSelection(showConnections ? null : selection);
  }, [readImports, selection, setTracedSelection, showConnections]);
  const selectDistrict = useCallback(
    (id: string) => {
      if (!territory) {
        return;
      }
      select({ regionId: id || undefined, territory });
    },
    [select, territory]
  );
  const selectFile = useCallback(
    (file: AtlasFile, symbol: AtlasSymbol | undefined) => {
      if (territory) {
        select({ file, symbol, territory });
      }
    },
    [select, territory]
  );
  const frameDistrict = useCallback(
    (ids: string[], districtId: string | undefined) => {
      if (!territory) {
        return;
      }
      if (districtId) {
        select({ regionId: districtId, territory });
      }
      setHover(null);
      scene.current?.focus(territory, undefined, ids);
    },
    [scene, select, setHover, territory]
  );
  const selectUnmappedModule = useCallback(
    (module: string) => {
      if (!territory) {
        return;
      }
      select({ territory, unmappedModule: module || undefined });
    },
    [select, territory]
  );
  const changeSettings = useCallback(
    (next: ChartSettings) => {
      if (next.layers !== chartPreference.current.layers) {
        setSelection(null);
        setHover(null);
      }
      if (!next.streams) {
        setSelection((current) =>
          current?.feature?.kind === "river"
            ? { territory: current.territory }
            : current
        );
        setHover((current) =>
          current?.feature?.kind === "river" ? null : current
        );
      }
      if (!next.volcanic && chartPreference.current.volcanic) {
        setSelection((current) =>
          current?.feature?.kind === "landmark"
            ? {
                file: current.feature.landmark.file,
                territory: current.territory,
              }
            : current
        );
        setHover((current) =>
          current?.feature?.kind === "landmark" ? null : current
        );
      }
      chartPreference.current = next;
      setChartSettings(next);
    },
    [chartPreference, scene, setChartSettings, setHover, setSelection]
  );
  const resetSettings = useCallback(() => {
    setSelection(null);
    setHover(null);
    const next = createAtlasState(sourceData).chartSettings;
    chartPreference.current = next;
    setChartSettings(next);
  }, [chartPreference, sourceData, setChartSettings, setHover, setSelection]);
  const closeWreck = useCallback(() => {
    setSelectedWreck(null);
  }, [setSelectedWreck]);
  const handleWreck = useCallback(
    (wreck: FormerPackage | null, selected: boolean) => {
      if (selected && wreck) {
        setSelectedWreck(wreck);
        scene.current?.focusWreck(wreck);
      } else if (!selected) {
        setHoveredWreck(wreck);
      }
    },
    []
  );
  const handleEscape = useCallback(() => {
    // With nothing selected, Escape puts away the chosen domain.
    if (!selectionRef.current && domainRef.current) {
      setDomain(null);
      return;
    }
    selectRef.current(resolveCurrentEscape(selectionRef.current));
  }, []);
  const state: AtlasState = {
    belongingLayer,
    chartSettings,
    data,
    developer: initial.developer,
    domain,
    geometry,
    hover,
    hoveredWreck,
    importsFailure: traced.failure,
    importsReading: traced.reading,
    layoutSettings,
    legendHeight,
    mapLayer,
    responsibility:
      !showConnections && responsibilityOverlay?.territoryId === territory?.id
        ? responsibilityOverlay
        : null,
    selectedWreck,
    selection,
    showConnections,
    territoryLayout,
    trades,
  };
  return {
    belonging,
    closeWreck,
    district: selectDistrict,
    domain: setDomain,
    escape: handleEscape,
    file: selectFile,
    frame: frameSelection,
    frameDistrict,
    hover: setHover,
    layout: setTerritoryLayout,
    legendHeight: setLegendHeight,
    mapLayer: changeMapLayer,
    overlay: setResponsibilityOverlay,
    reset: resetSettings,
    /** Reads the import edges again after a failed read, for the trace still on. */
    retryImports: readImports,
    scene,
    select,
    settings: changeSettings,
    state,
    trace: toggleTrace,
    trades: setTrades,
    unmappedModule: selectUnmappedModule,
    viewTerritory: setViewTerritory,
    wreck: handleWreck,
  };
}

/**
 * Every import edge, read the first time a trace asks (`read`), all of the
 * edge shards at once; with no reader (an atlas given its edges), nothing
 * to read. A failed read can be asked again.
 */
function useImports(
  imports: (() => Promise<AtlasData["fileEdges"]>) | undefined
) {
  const [edges, setEdges] = useState<AtlasData["fileEdges"] | null>(null);
  const [reading, setReading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const asked = useRef(false);
  const read = useCallback(() => {
    if (!imports || asked.current) {
      return;
    }
    asked.current = true;
    setReading(true);
    setFailure(null);
    // A read that ends after the atlas is gone sets state React ignores.
    imports().then(
      (value) => {
        setEdges(value);
        setReading(false);
      },
      (cause: unknown) => {
        asked.current = false;
        setReading(false);
        setFailure(
          cause instanceof Error ? cause.message : "Imports could not be read."
        );
      }
    );
  }, [imports]);
  return { edges, failure, read, reading };
}

/** Each frame with its late readings joined to the ones it was laid out with. */
function withLateReadings(atlas: AtlasData, late: LateReadings): AtlasData {
  return {
    ...atlas,
    frames: atlas.frames.map((frame) => {
      const read = late[frame.id];
      return read
        ? { ...frame, readings: { ...frame.readings, ...read } }
        : frame;
    }),
  };
}

/** The late readings once they arrive; a refusal is the caller's to show (`App`). */
function useLateReadings(late: Promise<LateReadings> | undefined) {
  const [readings, setReadings] = useState<LateReadings | null>(null);
  useEffect(() => {
    if (!late) {
      return;
    }
    let live = true;
    late.then(
      (value) => {
        if (live) {
          setReadings(value);
        }
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [late]);
  return readings;
}

function resolveValue(
  viewTerritory: Territory | null,
  mapLayer: MapLayer,
  viewIsSelected: boolean,
  selectedRegion: BelongingRegion | undefined,
  selectedComposite: BelongingRegion | undefined,
  selection: {
    feature?: AtlasSelection["feature"];
    compositeId: string | undefined;
    regionId: string | undefined;
    file?: AtlasFile;
    symbol?: { id: string; name: string };
    territory: Territory;
    unmappedModule?: string;
  } | null,
  mapBelonging: {
    composites: BelongingRegion[];
    data: AtlasInternals | undefined;
    error: string | undefined;
    features: NaturalFeatures | undefined;
    loading: boolean;
    regions: BelongingRegion[];
    retry: () => void;
  },
  belonging: {
    composites: BelongingRegion[];
    data: AtlasInternals | undefined;
    error: string | undefined;
    loading: boolean;
    regions: BelongingRegion[];
    retry: () => void;
  },
  territoryLayout: Territory | null
): BelongingLayer | null {
  if (viewTerritory && mapLayer === "belonging") {
    return {
      featureFocus: viewIsSelected ? selection?.feature : undefined,
      features:
        territoryLayout?.id === viewTerritory.id
          ? undefined
          : mapBelonging.features,
      files: viewIsSelected ? selectedRegion?.members : undefined,
      parents: resolveParents(
        viewIsSelected,
        selectedComposite,
        selectedRegion
      ),
      pinned: viewIsSelected ? selection?.regionId : undefined,
      regions: resolveRegions(
        viewIsSelected,
        selectedRegion,
        selectedComposite,
        mapBelonging
      ),
      surroundings:
        viewIsSelected && selectedComposite
          ? belonging.composites.filter(
              (region) => region !== selectedComposite && !region.collection
            )
          : [],
      territory:
        territoryLayout?.id === viewTerritory.id
          ? territoryLayout
          : viewTerritory,
    };
  }
  return null;
}

function resolveRegions(
  viewIsSelected: boolean,
  selectedRegion: BelongingRegion | undefined,
  selectedComposite: BelongingRegion | undefined,
  mapBelonging: {
    composites: BelongingRegion[];
    data: AtlasInternals | undefined;
    error: string | undefined;
    loading: boolean;
    regions: BelongingRegion[];
    retry: () => void;
  }
): BelongingRegion[] {
  if (viewIsSelected && selectedRegion) {
    return [];
  }
  if (viewIsSelected && selectedComposite) {
    return mapBelonging.regions.filter((region) =>
      selectedComposite.children?.includes(region.id)
    );
  }
  if (mapBelonging.composites.length) {
    return mapBelonging.composites;
  }
  return mapBelonging.regions;
}

function resolveParents(
  viewIsSelected: boolean,
  selectedComposite: BelongingRegion | undefined,
  selectedRegion: BelongingRegion | undefined
): BelongingRegion[] {
  if (viewIsSelected) {
    return [selectedComposite, selectedRegion].flatMap((region) =>
      region ? [region] : []
    );
  }
  return [];
}

function resolveCurrentEscape(
  current: {
    feature?: AtlasSelection["feature"];
    compositeId: string | undefined;
    regionId: string | undefined;
    file?: AtlasFile;
    symbol?: { id: string; name: string };
    territory: Territory;
    unmappedModule?: string;
  } | null
): AtlasSelection | null {
  if (current?.feature) {
    return { territory: current.territory };
  }
  if (current?.file) {
    return {
      compositeId: current.compositeId,
      regionId: current.regionId,
      territory: current.territory,
    };
  }
  if (current?.regionId) {
    return {
      compositeId: current.compositeId,
      territory: current.territory,
    };
  }
  if (current?.compositeId) {
    return { territory: current.territory };
  }
  return null;
}

function resolveSelectedBelonging(
  territory: Territory | undefined,
  viewTerritory: Territory | null,
  viewBelonging: {
    composites: BelongingRegion[];
    data: AtlasInternals | undefined;
    error: string | undefined;
    loading: boolean;
    regions: BelongingRegion[];
    retry: () => void;
  },
  territoryLayout: Territory | null
): Territory | undefined {
  if (territory?.id === viewTerritory?.id && viewBelonging.data) {
    return undefined;
  }
  if (territoryLayout?.id === territory?.id) {
    return territoryLayout ?? undefined;
  }
  return territory;
}

function selectionAncestry(
  initialValue: AtlasSelection | null,
  territory: Territory | undefined,
  belonging: {
    composites: BelongingRegion[];
    data: AtlasInternals | undefined;
    error: string | undefined;
    loading: boolean;
    regions: BelongingRegion[];
    retry: () => void;
  },
  selection: {
    feature?: AtlasSelection["feature"];
    compositeId: string | undefined;
    regionId: string | undefined;
    file?: AtlasFile;
    symbol?: { id: string; name: string };
    territory: Territory;
    unmappedModule?: string;
  } | null
): AtlasSelection | null {
  let value = initialValue;
  if (value && value.territory.id === territory?.id) {
    value = {
      ...value,
      ...belongingAncestry(belonging.regions, belonging.composites, {
        compositeId:
          value.compositeId ??
          (value.file || value.regionId ? selection?.compositeId : undefined),
        fileId: value.file?.id,
        regionId:
          value.regionId ?? (value.file ? selection?.regionId : undefined),
      }),
    };
  }
  return value;
}
