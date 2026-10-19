/** Screen-space bounds of the coordinate lettering, including its clearance. */
export interface FrameReference {
  edge: "top" | "left";
  halfWidth: number;
  position: number;
}

const inset = 8;
const center = 18;
const spread = 10;
const outer = center - spread;
const inner = center + spread;

function extent(
  references: readonly FrameReference[],
  edge: FrameReference["edge"],
  limit: number
) {
  const along = references.filter((reference) => reference.edge === edge);
  if (along.length === 0) {
    return null;
  }
  return {
    end: Math.min(
      limit - inner,
      Math.max(
        ...along.map(
          (reference) => reference.position + reference.halfWidth + 6
        )
      )
    ),
    start: Math.max(
      inner,
      Math.min(
        ...along.map(
          (reference) => reference.position - reference.halfWidth - 6
        )
      )
    ),
  };
}

/** The inset lining forks equally to either side of each coordinate run. Every shape is unfilled. */
export function chartFrame(
  width: number,
  height: number,
  references: readonly FrameReference[]
) {
  const right = width - inset;
  const bottom = height - inset;
  const top = extent(references, "top", width);
  const left = extent(references, "left", height);
  const joined =
    !!top &&
    !!left &&
    top.start <= inner + spread &&
    left.start <= inner + spread;
  const paths: string[] = [];
  const topEnd = top ? top.end + spread : center;
  const leftEnd = left ? left.end + spread : center;

  if (joined) {
    // The two sides of the split turn together, making a square at their intersection.
    paths.push(`M${outer} ${left.end} V${outer} H${top.end}`);
    paths.push(`M${inner} ${left.end} V${inner} H${top.end}`);
    paths.push(
      `M${top.end} ${outer} L${topEnd} ${center} L${top.end} ${inner}`
    );
    paths.push(
      `M${outer} ${left.end} L${center} ${leftEnd} L${inner} ${left.end}`
    );
  } else {
    if (top) {
      const start = top.start - spread;
      paths.push(`M${center} ${center} H${start}`);
      paths.push(
        `M${start} ${center} L${top.start} ${outer} H${top.end} L${topEnd} ${center} L${top.end} ${inner} H${top.start} Z`
      );
    }
    if (left) {
      const start = left.start - spread;
      paths.push(`M${center} ${center} V${start}`);
      paths.push(
        `M${center} ${start} L${outer} ${left.start} V${left.end} L${center} ${leftEnd} L${inner} ${left.end} V${left.start} Z`
      );
    }
  }
  paths.push(
    `M${topEnd} ${center} H${right} V${bottom} H${center} V${leftEnd}`
  );
  return {
    border: paths.join(" "),
    ornament: joined ? `M${center} ${center - 2} l2 2 -2 2 -2 -2 Z` : "",
  };
}
