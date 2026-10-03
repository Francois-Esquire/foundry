# Cartographic surface study

The first natural-feature pass improved evidence coverage but left the map's
visual foundation weak: enlarged coast texels, a grid that thickened with zoom,
shallow shadow artifacts, missing font assets, and file marks competing with
terrain. Adding more natural symbols did not address those problems.

## References and translation

- [Imhof's Walensee](https://ikgrelief.ethz.ch/examples/walensee/): coherent warm
  light and cool shadow make broad landforms readable. Atlas uses the existing
  file-concentration relief for that shading; it does not invent alpine heights.
- [Zermatt, 1891](https://ikgrelief.ethz.ch/examples/zermatt/): fine engraved slope
  strokes and clear settlement lettering share a restrained paper field. Atlas
  samples short fall-line hachures from its density slope, below settlement ink.
- [ETH's relief design guidance](https://ikgrelief.ethz.ch/design/): relief and
  water should agree, and cast shadows can confuse the drawing. Atlas removes
  shallow land cast shadows, and gives measured water a directional inset bank.
- [Tom Patterson's NPS map design](https://www.shadedrelief.com/realism/): terrain
  belongs together as a quiet base beneath explanatory information. Lighter
  package washes and bounded coast strokes let files retain the strongest ink.

The flat-grid and screen-grain pass was rejected: it lost the terrain's physical
presence. Grid ink now follows the actual relief mesh on land and stays flat on
water. Warm lit material, a lighter stock wash, and stationary fibers replace the
flat cool slope tint and pixel noise. Full-sheet folds remain removed.

Shared commons now use fitted summit signs. Composition junctions and the most
depended-on modules share that vocabulary, with the precise role in inspection.
An optional recorded-change layer adds craters from dated Git churn evidence;
craters on structural summits become volcanoes. These are engraved symbols over
unchanged density relief, not a second height metric. See DESIGN.md for the
thresholds, history population, and handling of unavailable evidence.

## What remains unresolved

The import graph is not a watershed. Directed cycles and unrelated crossing
relationships cannot all become noncrossing rivers while keeping fixed file
positions. Compatible mouths share trunks; omitted routes and their reasons
remain visible in Place. Some surviving arcs still look like connections rather
than tributaries. Streams remain optional and off initially.

Stream banks and summit signs remain cartographic shading, not carved mesh depth.
Relief height still means concentration only. Commons normally supply consumers;
streams retain that direction regardless of the landmark vocabulary.

Routing is materially slower than the independent-arc baseline. A browser probe
on this workspace measured Atlas at 330–426 ms and Quirks at 146–156 ms before
moving the same construction into a dedicated worker. Cached coast checks help;
the worker prevents that construction from blocking navigation, but does not
remove total computation. A synchronous fallback remains for unavailable workers.

The map key and keyboard feature index explain summits, recorded change, streams, and unresolved
marsh. Hover/selection describes the same evidence in Place and the polite live
region. The district chord chart, inland current, cycle signs, and physical basin
mesh are deferred rather than added to an already dense surface.
