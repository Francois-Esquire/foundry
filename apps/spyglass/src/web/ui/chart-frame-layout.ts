/** Screen-space bounds of the coordinate lettering, including its clearance. */
export interface FrameReference {
  edge: "top" | "left";
  halfWidth: number;
  position: number;
}

const inset = 8;
const center = 18;
const spread = 8;
const endGap = 12;
const finial = 6;
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
  const start = Math.min(
    ...along.map((reference) => reference.position - reference.halfWidth - 6)
  );
  const end = Math.max(
    ...along.map((reference) => reference.position + reference.halfWidth + 6)
  );
  if (end + spread < center || start - spread > limit - inset) {
    return null;
  }
  // Keep the shoulders inside the inset lining. The chart limits still drive
  // them, but a limit beyond the viewport must not take its V off the page.
  const lastShoulder = limit - inset - endGap - spread;
  const visibleStart = Math.max(
    center + endGap + spread,
    Math.min(lastShoulder, start)
  );
  const visibleEnd = Math.max(visibleStart, Math.min(lastShoulder, end));
  return {
    atCorner: start <= inner + spread,
    end: visibleEnd,
    start: visibleStart,
  };
}

function diamond(x: number, y: number, radius: number): string {
  return `M${x} ${y - radius} L${x + radius} ${y} L${x} ${y + radius} L${x - radius} ${y} Z`;
}

function shareCorner(
  top: ReturnType<typeof extent>,
  left: ReturnType<typeof extent>
): boolean {
  return !!top && !!left && top.atCorner && left.atCorner;
}

function endOf(range: ReturnType<typeof extent>): number {
  return range ? range.end + spread : center;
}

/** The persistent open corner diamond connects the cast rows and the plain lining at its points. */
export function chartFrame(
  width: number,
  height: number,
  references: readonly FrameReference[]
) {
  const right = width - inset;
  const bottom = height - inset;
  const top = extent(references, "top", width);
  const left = extent(references, "left", height);
  const joined = shareCorner(top, left);
  const paths: string[] = [];
  const panels: string[] = [];
  const ornaments: string[] = [];
  const topEnd = endOf(top);
  const leftEnd = endOf(left);
  const cornerRadius = 10;
  const junction = center + cornerRadius;
  if (top) {
    const start = joined ? junction : Math.max(center, top.start - spread);
    const shoulder = joined ? junction + spread : top.start;
    if (!joined) {
      paths.push(
        `M${junction} ${center} H${Math.max(junction, start - finial)}`
      );
      ornaments.push(diamond(start - finial / 2, center, finial / 2));
    }
    const panel = `M${start} ${center} L${shoulder} ${outer} H${top.end} L${topEnd} ${center} L${top.end} ${inner} H${shoulder} Z`;
    panels.push(panel);
    paths.push(panel);
    ornaments.push(diamond(topEnd + finial / 2, center, finial / 2));
  }
  if (left) {
    const start = joined ? junction : Math.max(center, left.start - spread);
    const shoulder = joined ? junction + spread : left.start;
    if (!joined) {
      paths.push(
        `M${center} ${junction} V${Math.max(junction, start - finial)}`
      );
      ornaments.push(diamond(center, start - finial / 2, finial / 2));
    }
    const panel = `M${center} ${start} L${outer} ${shoulder} V${left.end} L${center} ${leftEnd} L${inner} ${left.end} V${shoulder} Z`;
    panels.push(panel);
    paths.push(panel);
    ornaments.push(diamond(center, leftEnd + finial / 2, finial / 2));
  }
  paths.push(
    `M${top ? topEnd + finial : junction} ${center} H${right} V${bottom} H${center} V${left ? leftEnd + finial : junction}`
  );
  return {
    border: paths.join(" "),
    corner: diamond(center, center, cornerRadius),
    ornament: ornaments.join(" "),
    panels: panels.join(" "),
  };
}
