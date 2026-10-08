import { FileTree, useFileTree } from "@pierre/trees/react";
import { type CSSProperties, useCallback, useEffect, useMemo } from "react";

const treeStyle: CSSProperties = {
  "--trees-bg-muted-override": "var(--muted)",
  "--trees-bg-override": "var(--background)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-font-family-override": "var(--font-ui)",
  "--trees-font-size-override": "12px",
  "--trees-selected-bg-override": "var(--muted)",
  "--trees-selected-fg-override": "var(--foreground)",
  "--trees-selected-focused-border-color-override": "var(--ring)",
  height: "100%",
} as CSSProperties;

export function ModuleTree({
  paths,
  selected,
  onSelect,
}: {
  paths: string[];
  selected?: string;
  onSelect: (path: string) => void;
}) {
  const selection = useCallback(
    (selectedPaths: readonly string[]) => {
      const file = selectedPaths.find((candidate) => paths.includes(candidate));
      if (file) {
        onSelect(file);
      }
    },
    [paths, onSelect]
  );
  const { model } = useFileTree({
    density: "compact",
    icons: { colored: false, set: "minimal" },
    initialExpansion: "open",
    onSelectionChange: selection,
    paths,
  });
  const pathKey = JSON.stringify(paths);
  const stablePaths = useMemo<string[]>(() => JSON.parse(pathKey), [pathKey]);
  useEffect(() => model.resetPaths(stablePaths), [model, stablePaths]);
  useEffect(() => {
    if (selected && !model.getItem(selected)?.isSelected()) {
      model.getItem(selected)?.select();
    }
  }, [model, selected]);
  return <FileTree aria-label="Module files" model={model} style={treeStyle} />;
}
