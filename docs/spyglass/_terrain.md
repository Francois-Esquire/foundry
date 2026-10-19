# Spyglass structural terrain

Maintainer note, excluded from the Blume site. Dated 2026-10-19. This note
records the model under the map's islands: the fields that are composed, the
elevation convention, and the boundaries that are taken from the result. The
code is `apps/spyglass/src/lib/visualization/terrain.ts`.

## Order of work

Layout runs first and stops. `settlePackages` places islands, and
shared-dependency attraction adjusts the result within bounds. The terrain
reads the settled positions and cannot move an island. The terrain has no
path back into layout, so a change to the terrain does not change the layout.

## Fields

All fields are sampled on one grid over the chart, which extends past the
chart by the farthest reach of any contribution. Each field is kept separate
from the others:

| Field | Meaning | Composition |
| --- | --- | --- |
| Signed distance | The signed distance, in map units, from a point to the nearest island coast. It is negative on land. | Minimum over islands. |
| Contribution | One relationship's influence near its members, from 0 to 1. The value is computed from each member's signed distance and a falloff profile. The influence is lowered near islands outside the relationship. | Probabilistic union over the members of one contribution. |
| Shelf thickness | The sum of the contributions of shared third-party groups, each weighted by its number of dependencies. | Sum, without an upper limit. |
| Basement thickness | The sum of the contributions of internal workspace foundations, each weighted by its number of dependents. | Sum, without an upper limit. |
| Elevation | The height of the composed terrain. | Calculated from the formula in the next section. |
| Water depth | `waterLevel − elevation` where the result is greater than 0. | Calculated from the formula. |

Each contribution keeps its identity: its kind (`shared` or `internal`), its
member islands, and, for shared groups, every dependency it represents. A
union of shapes does not remove this information. A contribution keeps its
own values, and the thickness fields add the contributions.

**Shared groups** are the existing exact-membership groups of third-party
runtime dependencies. One group's weight is the sum, over its dependencies,
of the mean member weight. Transitive reliance therefore counts less than
direct reliance. The weight of a group with one shared dependency is about
1. The weight of a group with ten shared dependencies is about 10.

**Internal foundations** are workspace packages that other workspace packages
reach through runtime dependencies. One foundation's weight is the attenuated
number of its dependents. Its contribution covers the supplier and each
dependent, and the supplier's lobe is wider. This relationship is separate
from shared third-party code. In the measured Foundry workspace, `lib` and
`core` share no third-party runtime dependencies, but 7 and 8 packages
depend on them directly.

**Falloff profiles.** Each kind has a profile with a plateau, a width, and an
exponent. The plateau is the distance past the coast where the contribution
stays at full strength. The width sets the distance over which it falls off.
The exponent sets the shape of the fall: 1 is exponential, 2 is Gaussian, and
a larger exponent gives a steeper face.

**Recesses.** Near an island that is not a member, a contribution is
multiplied by a smoothstep of that island's signed distance. A shared shelf
therefore stops before an unrelated island and does not continue under it.
Where there is open water, a shelf falls off over the full profile width. A
non-member island nearby shortens the fall and makes a steep face.

## Elevation convention

The water level is 0. Land is above 0. The abyssal floor is at −1. The
chart is viewed from above, so the upper surface of the terrain is the only
part that is visible. In the ocean reading, the visible quantity is the
water depth over that surface. In the land reading, it is the height of
that surface. A foundation that extends downward does not change the upper
surface, so it cannot be seen in either reading. The convention therefore
uses two separate quantities:

- **Elevation:** As structure accumulates, the elevation rises from the
  abyss toward the water level. The rise is bounded and never reaches the
  water level.
- **Thickness:** The thickness is the number of relationships under a point,
  without an upper limit. It is kept as a separate field and can be
  inspected. It is not included in elevation, so a later cross-section or
  thickness view can still use it.

Internal foundations and shared shelves occupy different bands of the water
column:

```
 basement = abyss + (basementTop − abyss) · B / (B + basementHalf)
 struct   = basement + (shelfTop − basement) · T / (T + shelfHalf)
 offshore = smoothMax(coastDescent(signedDistance), struct)
```

The constants are `abyss = −1`, `basementTop = −0.6`, and
`shelfTop = −0.14`. A basement rises at most to `−0.6`. A basement is a
broad, deep platform. A shelf rises from the level of the basement below it,
or from the abyss where there is no basement, toward `−0.14`. Because the
shelf cap is below 0, a shoreline is always the zero crossing of the island's
own coast descent. A shelf never creates a new coast.

### Worked example

Islands A and B share three third-party dependencies, and the two islands
are close together. Both islands depend on `lib`, and five other packages
also depend on `lib`, so `lib`'s weight is 7. Island C depends on `lib` but
shares nothing with A or B. The basement is centred on `lib`. A dependent
receives half of `lib`'s influence (`dependentShare = 0.5`), so B is 7 at
`lib` and about 3.5 under a dependent. The constants are
`basementHalf = 8` and `shelfHalf = 4`.

| Location | B (basement) | T (shelf) | Elevation | Water depth |
| --- | --- | --- | --- | --- |
| Open ocean, far from everything | 0 | 0 | −1.00 | 1.00 |
| Beside `lib` | 7 | 0 | −0.81 | 0.81 |
| Beside C, a dependent only | 3.5 | 0 | −0.88 | 0.88 |
| Between A and B, with no `lib` | 0 | 3 | −0.63 | 0.63 |
| Between A and B, over `lib`'s basement | 3.5 | 3 | −0.56 | 0.56 |
| The same, with ten shared dependencies | 3.5 | 10 | −0.35 | 0.35 |
| On the A or B coast | — | — | 0 | 0 |

From above, `lib` and its dependents sit on a wide plateau of deep water,
and the plateau is highest at `lib`. A and B sit on a shallower shelf on top
of that plateau. The shelf becomes shallower as A and B share more
dependencies. C sits on the plateau, but its shelf stops before C, so the
water near C is deeper than the water between A and B. An island that
depends on nothing internal sits in a recess in the plateau.

Basements add: a package that depends on both `lib` and `core` sits on the
sum of both basements. In the measured Foundry workspace, most packages
depend on both, so the basement reaches about −0.7 there.

The other reading uses the same numbers. If more structure deepened the
foundation downward, the thickness field would hold those values: 3 or 10
under A–B, and 3.5 to 7 under `lib`'s basement. The elevation would not
change. To change the convention, change the band constants or read the
thickness field. Changing either one does not change the composition.

## Readings

The ocean and land readings share one elevation field and differ only in
the water level. The ocean reading uses `waterLevel = 0`, so the shoreline
is the island coasts and the shelves are submerged. The land reading lowers
the water level, so basements and shelves become land and keep the same
outline and slope. A land feature such as a cliff or a terrace is derived
from this elevation. The terrain does not draw outlines of its own.

## Boundaries

Four boundaries are taken from the fields, and each has a separate use:

- **Shorelines:** The coast polygons of each island. They are the shorelines
  of record. The zero crossing of the field approximates them but does not
  replace them.
- **Foundation boundaries:** For each contribution, the contour where its own
  value is 0.5. Each shared group and each internal foundation has its own
  boundary, and boundaries of different contributions can overlap.
- **Depth contours:** Contours of elevation at fixed levels. A contour or a
  terrace is calculated from the terrain. The terrain is never built from a
  contour.
- **Silhouette:** The outline of the region where elevation is greater than
  `abyss + silhouetteLift`. The silhouette can contain several separate
  regions and can contain holes. It replaces the old padded hull for the
  open-sea falloff, for the rim surf, and for the developer's outer
  boundary. The silhouette is an underwater contour, not a coastline.

The padded hull (`archipelagoHull`) remains only for the spacing between
frames in a collection. That spacing is layout.
