import { FileTree, useFileTree } from "@pierre/trees/react";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";

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
  paths: readonly string[];
  selected?: string;
  onSelect: (path: string) => void;
}) {
  // The tree keeps the options it was created with, so it reads the
  // files it shows through this ref.
  const shown = useRef(paths);
  const selection = useCallback(
    (selectedPaths: readonly string[]) => {
      const file = selectedPaths.find((candidate) =>
        shown.current.includes(candidate)
      );
      if (file) {
        onSelect(file);
      }
    },
    [onSelect]
  );
  const { model } = useFileTree({
    density: "compact",
    icons: { colored: false, set: "minimal" },
    initialExpansion: "open",
    onSelectionChange: selection,
    paths,
  });
  // Typing changes the source, not its files: reset only when they change.
  useEffect(() => {
    const same =
      shown.current.length === paths.length &&
      shown.current.every((path, index) => path === paths[index]);
    if (!same) {
      shown.current = paths;
      model.resetPaths(paths);
    }
  }, [model, paths]);
  useEffect(() => {
    if (selected && !model.getItem(selected)?.isSelected()) {
      model.getItem(selected)?.select();
    }
  }, [model, selected]);
  return <FileTree aria-label="Module files" model={model} style={treeStyle} />;
}
