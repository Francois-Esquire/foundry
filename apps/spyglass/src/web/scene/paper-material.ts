import { attribute, float, uniform } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { inkAlpha } from "../ladder/ink-ladder";
import { paperSurface, terrainGrid } from "./paper-surface";
import type { WeatherNodes } from "./weather";

/**
 * Lit matte paper lets the terrain's slopes and valleys carry its relief.
 * One material for every land surface: each mesh brings its own flat colour
 * as a `pigment` attribute (`pigmentAttribute`), so an island's wash and
 * the connecting land share the paper without a texture between them. The
 * paper lies under the scene's weather, whose clouds' light it reads.
 */
export function createPaperMaterials(
  weather: Pick<WeatherNodes, "cloudLight">
) {
  const strength = uniform(1);
  const paper = new MeshStandardNodeMaterial({
    metalness: 0,
    roughness: 0.96,
  });
  const occlusion = attribute<"float">("occlusion", "float");
  const pigment = attribute<"vec3">("pigment", "vec3");
  paper.colorNode = terrainGrid(paperSurface(pigment, weather)).mul(
    float(1).sub(occlusion.mul(strength).mul(inkAlpha.valleyShade))
  );
  return {
    dispose: () => {
      paper.dispose();
    },
    paper,
    setOcclusion: (value: number) => {
      strength.value = value;
    },
  };
}
