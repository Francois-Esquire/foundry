import "./corner-brackets.css";

const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"];

/**
 * A frame of four carbon corner brackets: a box with the middle of each side
 * left out. It is the frame of lettering observed in evidence and not yet
 * accepted. It fills the nearest positioned ancestor, three pixels in.
 */
export function CornerBrackets() {
  return (
    <span aria-hidden="true" className="ty-brackets">
      {CORNERS.map((corner) => (
        <span data-corner={corner} key={corner} />
      ))}
    </span>
  );
}
