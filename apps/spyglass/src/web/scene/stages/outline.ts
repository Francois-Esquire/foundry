import { color, float, vec4 } from "three/tsl";
import { inks } from "../../ladder/ink-ladder";
import type { Stage } from "./stage";

type OutlineInputs = typeof import("three/addons/tsl/display/OutlineNode.js");

/**
 * The mask is found at half resolution on every tier: a full-resolution mask
 * makes a one-pixel edge that the blur spreads thin, and the glow came out
 * several times dimmer on the Full tier than on the others.
 */
const downSampleRatio = 2;
/** How far the glow reaches past the coast, in device pixels. */
const thicknessPixels = 3;
/**
 * How much of the glow ink is added along the coast. The half-resolution
 * edge peaks near a quarter, so the core adds about half the ink: enough to
 * carry the sea past the bloom's threshold, which a softer glow never did.
 * The hidden edge, where a draped district or file mark lies a hair above
 * the terrain, takes the same strength: that is the only way an edge of the
 * chart's terrain is ever hidden, and it is not occlusion worth showing.
 */
const strength = 2;

/**
 * The selection's glow: the selected island's terrain, outlined by the
 * outline node and added to the image in the ladder's glow ink, so the ring
 * drawn as a mark is reinforced by light the bloom can lift. The edge is
 * found by drawing the selected meshes against the rest of the scene's
 * depth, so the stage draws the scene twice more while anything is
 * selected and nothing while the selection is empty. The glow is still:
 * the node's pulse stays at zero, so reduced motion needs nothing of it.
 */
export const outline: Stage<OutlineInputs> = {
  apply(frame, inputs) {
    const { camera, scene, selection } = frame;
    const edges = inputs.outline(scene, camera, {
      downSampleRatio,
      edgeThickness: float(thicknessPixels / downSampleRatio),
      selectedObjects: selection,
    });
    frame.nodes.push(edges);
    const edge = edges.visibleEdge.add(edges.hiddenEdge).mul(strength);
    const glow = color(inks.selectionGlow).mul(edge);
    frame.color = vec4(frame.color.rgb.add(glow), frame.color.a);
    return vec4(glow, 1);
  },
  id: "outline",
  label: "Selection glow",
  load: () => import("three/addons/tsl/display/OutlineNode.js"),
  needs(settings) {
    return settings.selectionGlow;
  },
};
