import assert from "node:assert/strict";
import { createServer } from "node:http";
import { app, dialog } from "electron";
import { registerRpcTransport } from "~/main/api/transport";
import {
  registerModuleProtocol,
  registerModuleScheme,
} from "~/main/modules/runtime/protocol";
import { registerQuitCleanup } from "~/main/quit";
import { openAppVault } from "~/main/vault/safe-storage";
import { createMainWindow, quitWindows } from "~/main/window";
import { registerWindowIpc } from "~/main/window-ipc";
import { runElectronSmoke, waitFor } from "../helpers/electron";
import { moduleReleasePackage } from "../helpers/module-release";
import { smokeWorks } from "../helpers/smoke-works";

registerModuleScheme();

// A deliberately small editor fixture, not a substitute for Sheets/Documents
// acceptance. Runs in a real sandboxed iframe and uses the selected wire API.
const HTML =
  '<!doctype html><textarea id="draft">retained draft</textarea><script src="/editor.js"></script>';
const SCRIPT = `
let connection;
document.body.dataset.document = crypto.randomUUID();
window.dirty = true;
window.report = () => {
  if (connection) connection.port.postMessage({ ...connection.message,
    type: 'foundry.editor-state/report', dirty: window.dirty });
};
addEventListener('message', event => {
  const message = event.data;
  if (event.source !== parent || message?.type !== 'foundry.editor-state/connect'
      || message.version !== 1 || event.ports.length !== 1
      || message.binding !== new URL(location.href).searchParams.get('binding')) return;
  connection?.port.close();
  connection = { message, port: event.ports[0] };
  window.report();
  document.body.dataset.connected = 'true';
});
parent.postMessage({ type: 'foundry.editor-state/ready', version: 1 }, '*');
`;

async function smoke(userData: string) {
  const server = createServer((request, response) => {
    const script = request.url === "/editor.js";
    response.setHeader(
      "Content-Type",
      script ? "text/javascript" : "text/html"
    );
    response.end(script ? SCRIPT : HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { encoded } = await moduleReleasePackage({
    capabilities: [],
    compatibility: { gateway: "1", runtime: "bun@1" },
    format: "foundry.module-manifest/1",
    network: {
      destinations: [{ host: "example.com" }],
      reason: "Restart fixture",
    },
    program: { entry: "outputs/program.js" },
    views: {
      editor: { path: "/", title: "Editor" },
      other: { path: "/other", title: "Other" },
    },
  });
  const works = await smokeWorks(userData, {
    programs: async () => ({
      revoked: () => undefined,
      shutdown: async () => undefined,
      start: async () => ({
        close: async () => undefined,
        origin: `http://127.0.0.1:${address.port}`,
      }),
    }),
  });
  await works.rpc.modules.importPackage(encoded);
  await works.rpc.access.approve("preview-fixture", "network");
  const { sessions } = works.rpc;
  registerModuleProtocol(sessions);
  registerRpcTransport({ ...works.rpc, vault: await openAppVault(userData) });
  registerWindowIpc();
  let window = createMainWindow();
  window.webContents.on("console-message", (event) =>
    process.stderr.write(`Renderer: ${event.message}\n`)
  );
  const evaluate = (code: string) => window.webContents.executeJavaScript(code);
  const frame = () =>
    window.webContents.mainFrame.frames.find((candidate) =>
      candidate.url.startsWith("module-app:")
    );
  const button = (text: string) =>
    evaluate(
      `Array.from(document.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(text)})?.click()`
    );
  const prompt = () =>
    evaluate("!!document.querySelector('[role=alertdialog]')");
  const settings = () =>
    evaluate(
      "document.querySelector('nav[aria-label=Main] a[aria-label=Settings]').click()"
    );
  let choice = 0;
  let dialogs = 0;
  const originalDialog = dialog.showMessageBoxSync;
  // Real Electron beforeunload/close/quit wiring; native dialog button choice
  // is deterministic here. This does not test OS dialog rendering/input.
  dialog.showMessageBoxSync = () => {
    dialogs += 1;
    return choice;
  };
  let completed = false;
  try {
    await waitFor(
      () => evaluate("!!document.querySelector('nav[aria-label=Main]')"),
      "Shell missing"
    );
    // Set the initial location before an editor is mounted; subsequent changes
    // use React Router links, so its actual blocker handles them.
    await evaluate("location.hash = '#/m/preview-fixture?view=editor'");
    await waitFor(
      async () =>
        !!frame() &&
        (await frame()?.executeJavaScript(
          "document.body.dataset.connected === 'true'"
        )) === true,
      "Editor handshake missing"
    );
    let initial = frame();
    assert.ok(initial);
    const initialUrl = initial.url;
    await settings();
    await waitFor(prompt, "Navigation did not ask");
    await button("Stay");
    assert.equal(frame(), initial);
    assert.equal(
      await initial.executeJavaScript("document.querySelector('#draft').value"),
      "retained draft"
    );

    await evaluate(
      "document.querySelector('#module-app-view').value = 'other'; document.querySelector('#module-app-view').dispatchEvent(new Event('change', { bubbles: true }))"
    );
    await waitFor(prompt, "View change did not ask");
    await button("Stay");
    assert.equal(frame(), initial);

    const firstDocument = await initial.executeJavaScript(
      "document.body.dataset.document"
    );
    await evaluate(
      "document.querySelector('#module-app-view').value = 'other'; document.querySelector('#module-app-view').dispatchEvent(new Event('change', { bubbles: true }))"
    );
    await waitFor(prompt, "View Leave did not ask");
    await button("Leave anyway");
    await waitFor(async () => {
      const current = frame();
      return (
        !!current &&
        current.url.endsWith("/other") &&
        (await current.executeJavaScript(
          "document.body.dataset.connected === 'true' && document.body.dataset.document"
        )) !== firstDocument &&
        (await current.executeJavaScript(
          "document.body.dataset.connected === 'true'"
        )) === true
      );
    }, "View Leave did not load a new connected document");
    initial = frame();
    assert.ok(initial);

    await initial.executeJavaScript(
      "history.replaceState(null, '', '?binding=created'); parent.postMessage({ type: 'foundry.editor-state/ready', version: 1 }, '*')"
    );
    await settings();
    await waitFor(prompt, "Create/reconnect cleared protection");
    await button("Stay");
    assert.equal(frame(), initial);
    const retainedUrl = initial.url;

    await works.rpc.access.revoke("preview-fixture", "network");
    assert.equal(
      (await works.rpc.access.get("preview-fixture")).grants.some(
        (grant) => grant.capability === "network"
      ),
      false
    );
    await waitFor(
      () =>
        evaluate(
          "document.body.textContent.includes('runtime stopped or changed access')"
        ),
      "Restart recovery missing"
    );
    assert.equal(frame(), initial);
    assert.equal(frame()?.url, retainedUrl);
    assert.equal(sessions.endpoint(new URL(initialUrl).host), undefined);
    assert.equal(
      await initial.executeJavaScript("document.querySelector('#draft').value"),
      "retained draft"
    );
    assert.equal(
      await initial.executeJavaScript("fetch('/').then(r => r.status)"),
      404
    );

    window.close();
    await waitFor(() => dialogs === 1, "Window close did not ask");
    assert.equal(window.isDestroyed(), false);
    assert.equal(frame(), initial);

    // A cancelled actual app.quit must not shut down the backend. A later
    // confirmed quit runs cleanup only after Electron destroyed the window.
    let cleanups = 0;
    let reports = 0;
    registerQuitCleanup(
      app,
      [
        [
          {
            shutdown: async () => {
              assert.equal(window.isDestroyed(), true);
              cleanups += 1;
              await works.close();
              await new Promise<void>((resolve) =>
                server.close(() => resolve())
              );
            },
          },
        ],
      ],
      () => {
        reports += 1;
      },
      () => quitWindows.close([window])
    );
    app.quit();
    await waitFor(() => dialogs === 2, "Quit did not ask");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(cleanups, 0);
    assert.equal(window.isDestroyed(), false);

    // Leave the retained dirty frame explicitly, then reopen a live editor.
    await settings();
    await waitFor(prompt, "Second navigation did not ask");
    await button("Leave anyway");
    await waitFor(
      () =>
        evaluate(
          "location.hash === '#/settings' && !document.querySelector('iframe')"
        ),
      "Route Leave failed"
    );
    await evaluate("location.hash = '#/m/preview-fixture?view=editor'");
    await waitFor(
      async () =>
        !!frame() &&
        (await frame()?.executeJavaScript(
          "document.body.dataset.connected === 'true'"
        )) === true,
      "Editor reopen missing"
    );
    choice = 1;
    // Close anyway is also the confirmation path used by an app quit.
    const closed = new Promise<void>((resolve) =>
      window.once("closed", () => resolve())
    );
    window.close();
    await closed;
    assert.equal(dialogs, 3);
    assert.equal(cleanups, 0);
    window = createMainWindow();
    await waitFor(
      () => evaluate("!!document.querySelector('nav[aria-label=Main]')"),
      "Second shell missing"
    );
    await evaluate("location.hash = '#/m/preview-fixture?view=editor'");
    await waitFor(
      async () =>
        !!frame() &&
        (await frame()?.executeJavaScript(
          "document.body.dataset.connected === 'true'"
        )) === true,
      "Final editor missing"
    );
    completed = true;
    // The smoke runner now issues a real app.quit with a dirty frame.
    app.once("will-quit", () => {
      assert.equal(cleanups, 1);
      assert.equal(dialogs, 4);
      assert.equal(reports, 0);
      process.stdout.write(
        "Electron editor state passed: route/View Stay+Leave; Create URL/reconnect stays protected; restart retains draft+revokes proxy; close Stay+Leave; quit Stay+confirmed cleanup. Native dialog choices stubbed; HTTP Program fixture.\n"
      );
    });
  } catch (error) {
    process.stderr.write(`${await evaluate("document.body.innerText")}\n`);
    process.stderr.write(
      `${window.webContents.mainFrame.frames.map((candidate) => candidate.url)}\n`
    );
    throw error;
  } finally {
    if (!completed) {
      dialog.showMessageBoxSync = originalDialog;
    }
    if (!(completed || window.isDestroyed())) {
      window.destroy();
      await works.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

runElectronSmoke("editor state", smoke);
