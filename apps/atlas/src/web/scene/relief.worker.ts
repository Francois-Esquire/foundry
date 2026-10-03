import { prepareRelief, type ReliefRequest } from "./prepare-relief";

self.onmessage = (event: MessageEvent<ReliefRequest>) => {
  const result = prepareRelief(event.data);
  const buffers = result.surfaces.flatMap((surface) => [
    surface.positions.buffer,
    surface.normals.buffer,
    surface.occlusion.buffer,
    surface.mineral.buffer,
  ]);
  self.postMessage(result, { transfer: buffers });
};
