import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { WebFrameMain } from "electron";
import { registerRpcTransport } from "~/main/api/transport";
import type { ModuleRuntime } from "~/main/modules/runtime/controller";
import {
  registerModuleProtocol,
  registerModuleScheme,
} from "~/main/modules/runtime/protocol";
import { createModuleRuntime } from "~/main/modules/runtime/runtime";
import { openAppVault } from "~/main/vault/safe-storage";
import { createMainWindow } from "~/main/window";
import { registerWindowIpc } from "~/main/window-ipc";
import { captureThemes, runElectronSmoke, waitFor } from "../helpers/electron";
import {
  moduleReleasePackage,
  PREVIEW_HTML,
  PREVIEW_SCRIPT,
} from "../helpers/module-release";
import { openLibrary, selectManagementView } from "../helpers/module-source";
import { smokeWorks } from "../helpers/smoke-works";

registerModuleScheme();

async function smoke(userData: string, [mode]: readonly string[]) {
  const { encoded, version } = await moduleReleasePackage();
  const server = createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/view.js" ? "text/javascript" : "text/html"
    );
    response.end(request.url === "/view.js" ? PREVIEW_SCRIPT : PREVIEW_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let starts = 0;
  let closes = 0;
  const real = mode === "runtime";
  // The preview's Program: under Microsandbox in runtime mode, otherwise
  // the local server above; either way its starts and closes are counted.
  const counted = (backing: ModuleRuntime): ModuleRuntime => ({
    revoked: (input) => backing.revoked(input),
    shutdown: () => backing.shutdown(),
    async start(release, signal) {
      const handle = await backing.start(release, signal);
      starts += 1;
      return {
        async close() {
          await handle.close();
          closes += 1;
        },
        origin: handle.origin,
      };
    },
  });
  const works = await smokeWorks(userData, {
    programs: async (options) =>
      counted(
        real
          ? await createModuleRuntime(options)
          : {
              revoked: () => undefined,
              shutdown: async () => undefined,
              async start() {
                return {
                  close: async () => undefined,
                  origin: `http://127.0.0.1:${address.port}`,
                };
              },
            }
      ),
  });
  const { sessions } = works.rpc;
  await works.rpc.modules.importPackage(encoded);
  registerModuleProtocol(sessions);
  registerRpcTransport({ ...works.rpc, vault: await openAppVault(userData) });
  registerWindowIpc();
  const window = createMainWindow();
  window.webContents.on("console-message", (_event, _level, message) =>
    process.stderr.write(`Renderer: ${message}\n`)
  );
  const evaluate = (code: string) => window.webContents.executeJavaScript(code);
  try {
    await openLibrary(window);
    await waitFor(
      () =>
        evaluate(
          `!!document.querySelector('a[href="#/modules/${version.moduleId}"]')`
        ),
      "Module library did not load"
    );
    await evaluate(
      `document.querySelector('a[href="#/modules/${version.moduleId}"]').click()`
    );
    await waitFor(
      () => evaluate("!!document.querySelector('[role=tab]')"),
      "Management did not load"
    );
    await selectManagementView(window, "Releases");
    await waitFor(
      () =>
        evaluate(
          'Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Start preview")'
        ),
      "Preview controls did not load"
    );
    await evaluate(
      'Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Start preview").click()'
    );
    const deadline = real ? 180_000 : 10_000;
    const startedAt = Date.now();
    let frame: WebFrameMain | undefined;
    while (Date.now() - startedAt < deadline) {
      // This smoke wires no authoring service, so the chat pane's own
      // "unavailable" alert is expected and not a preview failure.
      const error = await evaluate(
        'Array.from(document.querySelectorAll("[role=alert]")).find(alert => !alert.closest("[aria-label=\'Module chat\']"))?.textContent'
      );
      assert.equal(error, undefined, `Preview failed: ${error}`);
      frame = window.webContents.mainFrame.frames.find((candidate) =>
        candidate.url.startsWith("module-app:")
      );
      if (
        frame &&
        (await frame.executeJavaScript(
          'document.body?.dataset.ready === "true"'
        ))
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(frame, "Preview frame missing");
    assert.equal(
      await frame.executeJavaScript("document.body.dataset.ready"),
      "true"
    );
    assert.equal(
      await frame.executeJavaScript(
        'document.querySelector("#bridge").textContent'
      ),
      "Host bridge: undefined"
    );
    await frame.executeJavaScript('document.querySelector("#count").click()');
    assert.equal(
      await frame.executeJavaScript(
        'document.querySelector("#count").textContent'
      ),
      "Count: 1"
    );
    await captureThemes(window, real ? "module-runtime" : "module-app");
    await evaluate(
      'Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Stop preview").click()'
    );
    await waitFor(() => closes === 1, "Stop did not release the preview");
    await evaluate(
      'Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Start preview").click()'
    );
    await waitFor(() => starts === 2, "Preview did not restart");
    await evaluate(
      "document.querySelector('nav[aria-label=Main] a[aria-label=Home]').click()"
    );
    await waitFor(() => closes === 2, "Navigation did not release the preview");
    process.stdout.write(
      `Electron module preview passed: ${real ? "Microsandbox program" : "HTTP fixture"}, assets, scripts, bridge isolation, stop, navigation\n`
    );
  } finally {
    if (!window.isDestroyed()) {
      window.destroy();
    }
    await works.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runElectronSmoke("module preview", smoke);
