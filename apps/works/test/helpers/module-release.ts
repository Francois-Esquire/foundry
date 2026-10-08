import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { MODULE_MIME } from "@foundry/modules/constants";
import { defineModuleVersion, moduleIdSchema } from "@foundry/modules/domain";
import { encodeModulePackage } from "@foundry/modules/package";

export const PREVIEW_HTML =
  '<!doctype html><html><head><title>Preview fixture</title><style>body{font-family:system-ui,sans-serif;margin:24px}button{font:inherit}</style></head><body><h1>Running module view</h1><button id="count" type="button">Count: 0</button><p id="bridge"></p><script src="/view.js"></script></body></html>';
export const PREVIEW_SCRIPT =
  'let count = 0; document.querySelector("#count").onclick = (event) => { event.currentTarget.textContent = "Count: " + ++count; }; document.querySelector("#bridge").textContent = "Host bridge: " + typeof window.worksWindow; document.body.dataset.ready = "true";';
const program = `const server = Bun.serve({
  hostname: "0.0.0.0", port: Number(process.env.PORT || 3000),
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/_foundry/module-gateway" && server.upgrade(request)) { return; }
    if (path === "/_foundry/health") { return new Response("ok"); }
    if (path === "/") { return new Response(${JSON.stringify(PREVIEW_HTML)}, { headers: { "content-type": "text/html" } }); }
    if (path === "/view.js") { return new Response(${JSON.stringify(PREVIEW_SCRIPT)}, { headers: { "content-type": "text/javascript" } }); }
    return new Response(null, { status: 404 });
  },
  websocket: { message(socket, text) {
    const frame = JSON.parse(text);
    if (frame.kind === "hello") { socket.send(JSON.stringify({ kind: "ready", protocol: 1, mode: frame.mode })); }
    if (frame.kind === "heartbeat") { socket.send(JSON.stringify({ kind: "heartbeat", sequence: frame.sequence })); }
    if (frame.kind === "shutdown") { socket.close(); }
  } }
});`;

export async function moduleReleasePackage() {
  const artifacts = new ArtifactManager({ store: new InMemoryArtifactStore() });
  const bytes = new TextEncoder().encode(program);
  const artifact = await artifacts.create({
    entries: { "outputs/program.js": { bytes } },
    freeze: { tag: "1.0.0" },
    name: "Preview fixture",
    type: MODULE_MIME,
  });
  const { content } = artifact;
  if (!(content && "tree" in content)) {
    throw new Error("Fixture content missing");
  }
  const module = {
    artifactId: artifact.id,
    id: moduleIdSchema.parse("preview-fixture"),
  };
  const version = defineModuleVersion({
    artifact,
    content,
    manifest: {
      capabilities: [],
      compatibility: { gateway: "1", runtime: "bun@1" },
      format: "foundry.module/1",
      program: { entry: "outputs/program.js" },
      views: { main: { path: "/", title: "Fixture" } },
    },
    module,
  });
  return {
    encoded: await encodeModulePackage({
      artifact,
      content,
      files: { "outputs/program.js": bytes },
      module,
      version,
    }),
    version,
  };
}
