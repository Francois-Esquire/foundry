import { contextBridge, ipcRenderer } from "electron";
import { forwardRpcPort, RPC_CHANNELS } from "~/shared/rpc";
import { createWindowBridge } from "~/shared/window-bridge";

contextBridge.exposeInMainWorld(
  "worksWindow",
  createWindowBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args))
);

// A MessagePort cannot cross the context bridge, so the renderer posts it to
// its own window and the preload carries it the rest of the way to main.
window.addEventListener("message", (event) => {
  forwardRpcPort(event, window, (port) => {
    ipcRenderer.postMessage(RPC_CHANNELS.serverStart, null, [port]);
  });
});
