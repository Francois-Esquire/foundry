import type { CSSProperties } from "react";

type WindowControlVariant = "close" | "maximize" | "minimize";

const VARIANT_STYLES: Record<
  WindowControlVariant,
  { color: string; label: string }
> = {
  close: { color: "#ff5f57", label: "Close" },
  maximize: { color: "#28c840", label: "Maximize" },
  minimize: { color: "#febc2e", label: "Minimize" },
};

const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

function WindowControlButton({
  variant,
  onClick,
}: {
  variant: WindowControlVariant;
  onClick: () => void;
}) {
  const { color, label } = VARIANT_STYLES[variant];

  return (
    <button
      aria-label={label}
      className="h-3 w-3 cursor-pointer rounded-full transition-[filter] hover:brightness-110"
      onClick={onClick}
      style={{ ...NO_DRAG, backgroundColor: color }}
      type="button"
    />
  );
}

export interface WindowControlsProps {
  onClose: () => void;
  onMaximize?: () => void;
  onMinimize: () => void;
}

export function WindowControls({
  onMinimize,
  onClose,
  onMaximize,
}: WindowControlsProps) {
  return (
    <div className="flex items-center gap-1.5" style={NO_DRAG}>
      <WindowControlButton onClick={onMinimize} variant="minimize" />
      {onMaximize ? (
        <WindowControlButton onClick={onMaximize} variant="maximize" />
      ) : null}
      <WindowControlButton onClick={onClose} variant="close" />
    </div>
  );
}
