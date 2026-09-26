# Folklore and atmosphere

An ambient and interaction-driven extension to Phase 3. A dependency-derived
sea current joins coastlight and pointer wind.
The atlas responds to the person exploring it before agents ever inhabit it.
Preserve the paper, mineral pigments, tilted lettering and accepted geography.

## What the movement means

Hover, keyboard focus, selection and camera approach may awaken decorative
effects. These express attention and discovery, never agent presence, execution,
progress, code health or changes to the survey. Settlement marks remain files.
Do not make files wander, flash as if completing tasks or emit fake work events.

Future agent activity remains Phase 5 and needs its own visual language tied to
real events. Atmospheric motion must be independently suppressible. Explain it
in the map guide as decorative, without adding warning boxes over the map.

## Candidate moments

These are ideas to try, not a checklist to implement together.

| Moment                        | Response                                                                                                          | Restraint                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Arrive at an island           | Warm amber light gathers along its actual coastline, including its smaller islands.                               | Soft reflected light, not a neon outline or a pulsing selection ring. Fade on departure; preserve a distinct selected state. |
| Move along a coast            | A short glint travels through the shallows behind the cursor, then settles into the paper.                        | Follow existing water boundaries, never alter the silhouette or leave a permanent trail.                                     |
| Approach a neighborhood       | A brief rustle of ink and tiny dust motes passes between settlements, like a miniature place waking to attention. | Files stay anchored. No workers, task badges, traffic counts or completion signals.                                          |
| Pause over open sea           | A few engraved wind strokes uncurl, drift across the water and disappear.                                         | Long quiet intervals, curved strokes rather than dependency-style dashed lines. Avoid land and lettering.                    |
| Finish a camera journey       | A faint wake relaxes across nearby water as the view settles.                                                     | One short response, not a cursor particle stream or an effect throughout every pan.                                          |
| Linger near a remote shore    | A sea serpent reveals a few etched coils, then sinks beneath a small ripple.                                      | Rare, offshore, non-interactive. Never hide a file or suggest an undiscovered package.                                       |
| Explore a wide stretch of sea | A tiny winged dragon crosses a clear patch of water and fades back into ink.                                      | Match the atlas engraving and perspective. No bright cartoon sprite, sound cue or collectible reward.                        |
| Return to a familiar bay      | A sleeping leviathan, a small school of engraved fish or a passing ray offers a different quiet sighting.         | Choose sparingly from a small family. Do not decorate every inlet.                                                           |

The overview has moving sea pigment. File inspection stays quiet. Clouds and creatures
are deferred after the rejected sprite experiment.

## Choreography and boundaries

- Coastlight gives immediate feedback. Wind and sightings wait for a settled
  view or a pause in exploration; cancel pending appearances when focus changes.
- Keep emphasis on the current island or neighborhood. Allow one creature at a
  time if creatures return; the background current may coexist with it.
- Derive coastlight from existing contours. Place ocean effects only in verified
  water with clearance from land, labels, routes and controls. Skip when no clear
  space exists; do not move geography to make room.
- Keep decorative strokes visibly different from directed import routes. Do not
  animate apparent traffic along dependency lines as ambient decoration.
- Effects never capture pointer input or become required navigation targets.
  Keyboard focus gets equivalent emphasis; touch selection works without hover.
- Reduced motion retains a static atmospheric composition and coast emphasis.
  The overview sea material updates at at most 30 fps; shadows stay cached. Pause all
  atmosphere in hidden views and release its resources on teardown.

## Implemented first experiment

Hover, index focus and selection light the territory's existing coast contours,
including holes and disconnected islands. The projected canvas layer uses soft
amber strokes and does not capture pointer input. Leaving hover restores the
selected territory's emphasis or fades the coastlight away. Keyboard focus and
touch selection receive the same coast treatment.

A one-second pointer pause over open water can trigger three curved engraved
wind strokes. They reveal and recede over 2.4 seconds. A 12-second cooldown starts
with the gesture; no new event occurs without another pointer pause. Placement
checks the path against coasts, shallows, visible labels, package routes, compass,
sea caption and viewport edges. Unclear space produces no gesture. File detail
suppresses wind, and camera movement cancels it.

The "Decorative atmosphere" toggle defaults on, exposes `aria-pressed` and
controls both effects independently of navigation. Scene creation applies the
latest toggle preference after fonts load, including a change made while waiting.
Reduced motion keeps the composition static and omits wind. Animation frames end
in file detail. Hidden tabs and offscreen maps cancel pending wind
and animation; teardown removes the canvas, timers, frames, listeners and observer.

The geography and survey-loading behavior are unchanged. Neighborhood bustle,
clouds, creatures, historical continuity and agents are not implemented.

## Overview weather

Cloud and serpent sprites were removed at the user's request. Their side-view
illustration conflicted with the map projection; the serpent's changing position
also felt detached from the water. Do not reuse those assets. Any future attempt
needs matching overhead perspective and stable placement within the scene.

## Dependency undercurrent

Direction means importer to imported package, not the reverse direction of value
or code execution. Only known cross-package file-import edges contribute. Internal
imports remain within land and do not drive sea crossings. No package exports or
semantic-surface tooling changes are required.

- Count directed file edges by package pair, then use log(1 + count) as weight.
- The normalized weighted direction sum gives the prevailing flow. Exact
  cancellation uses the strongest pair with stable package-ID tie breaking.
  A survey without cross-package edges has no invented current.
- Each connection adds a smooth Gaussian influence around its crossing, widened
  by package size. Blend that influence with the prevailing vector. There are
  no district cells or hard borders.
- Project the dependency field around the actual rasterized coast masks. Solid
  faces block flow; a bounded pressure solve redirects it through water. The
  upstream current splits, accelerates along flanks and rejoins downstream.
  The map's outer edges remain open. Solve once per scene, not per frame.
- Fade pigment only in the first six map units of water so the current remains
  visible beside shore. Midpoint integration checks both the intermediate and
  destination samples against land, avoiding long shader steps across islands.
  This is an approximate steady flow, not a full breaking-wave simulation.
- Compute a 256-cell-wide-or-high flow texture once per scene. The sea shader
  backtracks through it to advect pigment, using two crossfaded phases to avoid
  reset jumps. Smooth variation supplies pigment only; it does not pick direction.
- Pigment travels at a 36-map-unit velocity scale with a six-second phase cycle.
  Five flow-aligned samples retain streaks without averaging away their motion.
  Contrast is stronger than the first current pass; geography and base colors
  are unchanged. Inspect one-second intervals, not merely unequal frames.
- Current strength is illustrative, not a calibrated dependency-count legend.
  The geometry, land material, labels and contours remain unchanged.

This replaces the separate repeating wave marks. Clouds and creatures remain
removed. Hidden/offscreen views stop the shared animation clock; reduced motion
uses a frozen current. Turning atmosphere off restores the original sea pigment.

All overview effects fade smoothly between 0.8 and 2.8 CSS pixels per map unit.
The atmosphere switch controls them together with coastlight and wind. No file
positions, terrain heights, coastlines, palette values or survey fields change.

The obstacle treatment follows the pressure-projection approach described in
[GPU Gems, fluid boundaries](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids).
Tests cover upstream splitting, both flanks, downstream reunion, still water and
zero velocity inside land. The finite grid does not resolve sub-cell inlets.

## Verification

### Chart settings and playback scope

The painted compass and a keyboard-accessible compass button open Chart settings.
The paper margin panel contains Wind, Current, Waves, Appearance and Playback.
On narrow screens it covers the map until closed. Closing restores button focus;
Escape closes settings before changing map selection.

Wind direction means travel toward that compass bearing. Strength and influence
blend wind with the dependency current; neither changes file relationships or land.
Wave amount, wavelength and strength tune a depth-aware wavefront approximation.
Water pigment, contrast and contour visibility change presentation only. The
pigment picker scales the sea's linear RGB channels relative to the original
pigment, retaining depth shading and animated variation. Original, Treasure
parchment, Graphite and Faded pigments are map-only CSS filter passes. Monochrome
filters remove package color distinctions; the index and controls stay unfiltered.
Reset restores
the documented defaults, track states and timeline origin. No settings persist.

One master clock owns Current, Wind and Waves tracks. Global pause freezes all;
individual pause freezes one track while the others continue. Pausing wind freezes
its visible ripple pattern, not the steady force from its direction and strength.
Master speed affects active tracks. Scrubbing intentionally seeks every track,
including paused ones, to the same time and pauses playback. Resume retains each
track's play state. Future tracks extend this list; no event editor, keyframes,
agent telemetry or saved compositions are part of this change.

Reduced motion starts with a static composition and still permits explicit seeks.
Hidden/offscreen maps suspend animation. Field solves happen during setup, not
per frame. Shader controls update uniforms; wind direction updates wave arrival
times after a short debounce. Verify each control's effect, independent pause,
master pause/resume/seek, reset, keyboard focus and mobile containment.

### Programmatic current playback

`scene.setCurrentTime(milliseconds)` pins the shader clock. Pass `null` to resume.
The atlas host exposes the same control for browser inspection:

```js
const currentTime = (milliseconds) =>
  document
    .querySelector(".atlas-map")
    .dispatchEvent(
      new CustomEvent("atlas:current-time", { detail: milliseconds }),
    );
currentTime(0);
currentTime(5000);
currentTime(10000);
currentTime(null);
```

Manual time stays fixed across camera changes and works with reduced motion.
The atmosphere toggle and detail fade still apply. Invalid times are ignored.
Playback uses elapsed wall time, not a capped frame delta. The previous 50 ms
cap slowed a 300 ms frame to one-sixth speed; a regression test covers this case.

### Initial coastlight verification

Nine browser captures were visually approved. Browser checks passed for pointer
and keyboard coastlight, departure fade, wind settling, toggle behavior,
mobile and touch selection, reduced motion, and toggling while fonts were delayed.
Review found one initialization-state bug; the latest-preference fix resolved it.
All 19 tests, typecheck, lint, formatting and production build passed. Existing
build warnings remain. No performance benchmark was recorded.

Success means the response feels attached to the place being explored, names
and routes remain readable, and nobody mistakes the motion for agents working.
This extension does not advance historical continuity or agent integration.
