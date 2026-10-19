/** Upright in screen space: the chart's north stays north as the camera tilts. */
export function CompassRose() {
  return (
    <svg
      aria-hidden="true"
      className="spyglass-compass-rose"
      viewBox="0 0 100 100"
    >
      <circle className="spyglass-compass-ring" cx="50" cy="50" r="34" />
      <circle className="spyglass-compass-ring" cx="50" cy="50" r="30" />
      <path
        className="spyglass-compass-minor"
        d="M28 28 50 42 72 28 58 50 72 72 50 58 28 72 42 50Z"
      />
      <path
        className="spyglass-compass-light"
        d="M50 15 58 42 85 50 58 58 50 85 42 58 15 50 42 42Z"
      />
      <path
        className="spyglass-compass-dark"
        d="M50 15V50L42 42ZM85 50H50L58 42ZM50 85V50L58 58ZM15 50H50L42 58Z"
      />
      <circle className="spyglass-compass-hub" cx="50" cy="50" r="4" />
      <text x="50" y="10">
        N
      </text>
      <text x="93" y="53">
        E
      </text>
      <text x="50" y="98">
        S
      </text>
      <text x="7" y="53">
        W
      </text>
    </svg>
  );
}
