import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { MODULE_MIME } from "@foundry/modules/constants";
import { defineModuleVersion, moduleIdSchema } from "@foundry/modules/domain";
import { encodeModulePackage } from "@foundry/modules/package";
import { MODULE_SDK_EMITTED } from "@foundry/modules/sdk/emitted";

export const PREVIEW_HTML =
  '<!doctype html><html><head><title>Preview fixture</title><style>body{font-family:system-ui,sans-serif;margin:24px}button{font:inherit}</style></head><body><h1>Running module view</h1><button id="count" type="button">Count: 0</button><p id="bridge"></p><script src="/view.js"></script></body></html>';
export const PREVIEW_SCRIPT =
  'let count = 0; document.querySelector("#count").onclick = (event) => { event.currentTarget.textContent = "Count: " + ++count; }; document.querySelector("#bridge").textContent = "Host bridge: " + typeof window.worksWindow; document.body.dataset.ready = "true";';
/** `/probe?url=` fetches from inside the Program, for network smokes. */
const program = `const server = Bun.serve({
  hostname: "0.0.0.0", port: Number(process.env.PORT || 3000),
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/_foundry/module-gateway" && server.upgrade(request)) { return; }
    if (path === "/_foundry/health") { return new Response("ok"); }
    if (path === "/probe") {
      const target = new URL(request.url).searchParams.get("url");
      return fetch(target, { signal: AbortSignal.timeout(5000) }).then(
        (response) => new Response("reached " + response.status),
        (error) => new Response("blocked " + error.message)
      );
    }
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

const THEME_VIEW_HTML =
  '<!doctype html><html><head><title>Theme fixture</title></head><body><h1>Theme fixture</h1><script type="module" src="/theme-view.js"></script></body></html>';
/**
 * The View follows the host theme through the SDK's browser helper and shows
 * it on `<body>` data attributes; `startTheme`/`stopTheme` reconnect and
 * disconnect it, and `themeEvents` lists every report (null = unavailable).
 */
const THEME_VIEW_SCRIPT = `import { watchModuleTheme } from "/sdk.js";
let controller;
window.themeEvents = [];
const show = (theme) => {
  window.themeEvents.push(theme);
  document.body.dataset.mode = theme ? theme.mode : "";
  document.body.dataset.effective = theme ? theme.effective : "";
};
window.startTheme = () => {
  controller?.abort();
  controller = new AbortController();
  watchModuleTheme(show, { retryMs: 200, signal: controller.signal });
};
window.stopTheme = () => controller?.abort();
window.startTheme();
document.body.dataset.ready = "true";`;
/**
 * A Program composed like the template's: the Module SDK owns the Gateway
 * socket and relays the theme at `/_module/theme`. It prints its port.
 */
const THEME_PROGRAM = `import { createProgramGateway, relayModuleTheme } from "./sdk.js";
const gateway = createProgramGateway();
const sdk = await Bun.file(new URL("./sdk.js", import.meta.url)).text();
const asset = (body, type) => new Response(body, { headers: { "content-type": type } });
const server = Bun.serve({
  hostname: "0.0.0.0", port: Number(process.env.PORT ?? 3000),
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/_foundry/module-gateway" && server.upgrade(request)) { return; }
    if (path === "/_foundry/health") { return new Response("ok"); }
    if (path === "/_module/theme") { return relayModuleTheme(gateway, request); }
    if (path === "/") { return asset(${JSON.stringify(THEME_VIEW_HTML)}, "text/html"); }
    if (path === "/theme-view.js") { return asset(${JSON.stringify(THEME_VIEW_SCRIPT)}, "text/javascript"); }
    if (path === "/sdk.js") { return asset(sdk, "text/javascript"); }
    return new Response(null, { status: 404 });
  },
  websocket: gateway.websocket,
});
process.stdout.write("listening " + server.port + "\\n");`;

/** The theme fixture's release files: the Program and the SDK it imports. */
export const THEME_PROGRAM_FILES: Readonly<Record<string, string>> = {
  "outputs/program.js": THEME_PROGRAM,
  "outputs/sdk.js": MODULE_SDK_EMITTED.esm,
};

/** A Manifest selecting `works.system.theme` under the relay's alias. */
export const THEME_MANIFEST = {
  capabilities: [
    {
      alias: "theme",
      capability: "works.system.theme",
      reason: "Matches the host appearance",
      version: 1,
    },
  ],
  compatibility: { gateway: "1", runtime: "bun@1" },
  format: "foundry.module/1",
  program: { entry: "outputs/program.js" },
  views: { main: { path: "/", title: "Theme fixture" } },
} as const;

/** A released package of the theme fixture Program. */
export function themeReleasePackage() {
  return moduleReleasePackage(THEME_MANIFEST, THEME_PROGRAM_FILES);
}

/** A released package of the fixture Program; `manifest` replaces its Manifest. */
export async function moduleReleasePackage(
  manifest?: object,
  sources: Readonly<Record<string, string>> = { "outputs/program.js": program }
) {
  const artifacts = new ArtifactManager({ store: new InMemoryArtifactStore() });
  const files = Object.fromEntries(
    Object.entries(sources).map(([path, text]) => [
      path,
      new TextEncoder().encode(text),
    ])
  );
  const artifact = await artifacts.create({
    entries: Object.fromEntries(
      Object.entries(files).map(([path, bytes]) => [path, { bytes }])
    ),
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
    manifest: manifest ?? {
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
      files,
      module,
      version,
    }),
    version,
  };
}
