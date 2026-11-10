import "./tofu.css";

interface TofuProps {
  /** Spoken name. Leave out when text beside the box already says it. */
  readonly label?: string;
  /** Height in pixels. The box keeps the proportion of a character. */
  readonly size?: number;
}

/**
 * The crossed box that stands for a missing character. Drawn by the app so
 * a gap in coverage never shows a system fallback font.
 */
export function Tofu({ label, size = 30 }: TofuProps) {
  const dimensions = { height: size, width: Math.round(size * 0.72) };
  const cross = <path d="M0 0 10 10M10 0 0 10" />;
  return label ? (
    <svg
      aria-label={label}
      className="ty-tofu"
      preserveAspectRatio="none"
      role="img"
      style={dimensions}
      viewBox="0 0 10 10"
    >
      {cross}
    </svg>
  ) : (
    <svg
      aria-hidden="true"
      className="ty-tofu"
      preserveAspectRatio="none"
      style={dimensions}
      viewBox="0 0 10 10"
    >
      {cross}
    </svg>
  );
}
