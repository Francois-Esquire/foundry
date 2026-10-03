import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BelongingLayer } from "../belonging";
import { type BelongingRegion, belongingAncestry } from "../belonging";
import type { ChartSettings } from "../chart-settings";
import type { AtlasInternals } from "../internals";
import { relayoutAtlas } from "../landmasses";
import type { NaturalFeatures } from "../natural-features";
import type { ResponsibilityOverlay } from "../responsibility-focus";
import { trackIds } from "../scene/playback";
import type { AtlasSelection } from "../scene/scene";
import type { TradeRoute } from "../trade-routes";
import type {
  AtlasData,
  AtlasFile,
  AtlasSymbol,
  FormerPackage,
  Territory,
} from "../types";
import type { AtlasMapHandle } from "./atlas-map";
import { type AtlasState, createAtlasState } from "./atlas-state";

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

function selectionGroup(
  value: AtlasSelection | null,
  layout: Territory | null
) {
  const territory =
    layout?.id === value?.territory.id ? layout : value?.territory;
  return (
    value?.neighborhoodId ??
    territory?.neighborhoods.find((group) =>
      group.members.includes(value?.file?.id ?? "")
    )?.id ??
    ""
  );
}

export function useAtlasState(initial: AtlasState) {
  const sourceData = initial.data;
  const [layoutSettings, setLayoutSettings] = useState(initial.layoutSettings);
  const data = useMemo(
    () =>
      layoutSettings === initial.layoutSettings
        ? sourceData
        : relayoutAtlas(sourceData, layoutSettings),
    [sourceData, layoutSettings, initial.layoutSettings]
  );
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
  const [lens, setLens] = useState<"belonging" | "files">(initial.lens);
  const [tracedSelection, setTracedSelection] = useState<AtlasSelection | null>(
    null
  );
  const [responsibilityOverlay, setResponsibilityOverlay] =
    useState<ResponsibilityOverlay | null>(initial.responsibility);
  const [territoryLayout, setTerritoryLayout] = useState<Territory | null>(
    initial.territoryLayout
  );
  const [viewTerritory, setViewTerritory] = useState<Territory | null>(null);
  const territoryLayoutRef = useRef<Territory | null>(null);
  const [atmosphereEnabled, setAtmosphereEnabled] = useState(
    initial.atmosphereEnabled
  );
  const [chartSettings, setChartSettings] = useState(initial.chartSettings);
  const chartPreference = useRef(chartSettings);
  const { coastalBuffer, islandClearance } = chartSettings;
  const territory = chosen?.territory;
  const viewBelonging = useBelonging(
    viewTerritory ?? undefined,
    data.generatedAt,
    chartSettings.volcanic
  );
  const selectedBelonging = useBelonging(
    resolveSelectedBelonging(
      territory,
      viewTerritory,
      viewBelonging,
      territoryLayout
    ),
    data.generatedAt,
    chartSettings.volcanic
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
      const group = selectionGroup(value, territoryLayoutRef.current);
      if (!value?.symbol && value?.file) {
        scene.current?.focus(value.territory, value.file, group);
      } else if (
        !(
          value?.feature ||
          value?.symbol ||
          value?.regionId ||
          value?.compositeId
        )
      ) {
        scene.current?.focus(value?.territory ?? null, value?.file, group);
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
      territoryLayoutRef,
    ]
  );
  const selectRef = useRef(select);
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectRef.current = select;
    selectionRef.current = selection;
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
      territoryLayoutRef.current = null;
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
        lens,
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
      lens,
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
  useEffect(() => {
    territoryLayoutRef.current = territoryLayout;
  }, [territoryLayout]);
  const frameSelection = useCallback(
    (ids: string[]) => {
      if (territory) {
        scene.current?.focus(territory, undefined, undefined, ids);
      }
    },
    [scene, territory]
  );
  const changeLens = useCallback(
    (value: "belonging" | "files") => {
      setLens(value);
      if ((selection?.regionId || selection?.compositeId) && territory) {
        select({ territory });
      }
    },
    [select, selection, setLens, territory]
  );
  const toggleTrace = useCallback(() => {
    setTracedSelection(showConnections ? null : selection);
  }, [selection, setTracedSelection, showConnections]);
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
      scene.current?.focus(territory, undefined, undefined, ids);
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
    for (const id of trackIds) {
      scene.current?.setTrackPlaying(id, true);
    }
    scene.current?.setPlaybackSpeed(1);
    scene.current?.seek(0);
    scene.current?.play(
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    setAtmosphereEnabled(false);
  }, [
    chartPreference,
    sourceData,
    scene,
    setAtmosphereEnabled,
    setChartSettings,
    setHover,
    setSelection,
  ]);
  const toggleAtmosphere = useCallback(() => {
    const enabled = !atmosphereEnabled;
    setAtmosphereEnabled(enabled);
  }, [atmosphereEnabled, setAtmosphereEnabled]);
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
    selectRef.current(resolveCurrentEscape(selectionRef.current));
  }, []);
  const state: AtlasState = {
    atmosphereEnabled,
    belongingLayer,
    chartSettings,
    data,
    hover,
    hoveredWreck,
    layoutSettings,
    lens,
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
    atmosphere: toggleAtmosphere,
    belonging,
    closeWreck,
    district: selectDistrict,
    escape: handleEscape,
    file: selectFile,
    frame: frameSelection,
    frameDistrict,
    hover: setHover,
    layout: setTerritoryLayout,
    lens: changeLens,
    overlay: setResponsibilityOverlay,
    reset: resetSettings,
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

function resolveValue(
  viewTerritory: Territory | null,
  lens: "belonging" | "files",
  viewIsSelected: boolean,
  selectedRegion: BelongingRegion | undefined,
  selectedComposite: BelongingRegion | undefined,
  selection: {
    feature?: AtlasSelection["feature"];
    compositeId: string | undefined;
    regionId: string | undefined;
    file?: AtlasFile;
    neighborhoodId?: string;
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
  if (viewTerritory && lens === "belonging") {
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
    neighborhoodId?: string;
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
    neighborhoodId?: string;
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
