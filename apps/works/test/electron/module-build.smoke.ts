import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { app, type BrowserWindow } from "electron";
import { registerRpcTransport } from "~/main/api/transport";
import { ModuleBuilds } from "~/main/modules/builds/controller";
import { createBuildRuntime } from "~/main/modules/builds/runtime";
import {
  moduleDirectory,
  openLocalModuleLibrary,
} from "~/main/modules/local-library";
import { ModuleSessions } from "~/main/modules/runtime/controller";
import {
  registerModuleProtocol,
  registerModuleScheme,
} from "~/main/modules/runtime/protocol";
import { createModuleRuntime } from "~/main/modules/runtime/runtime";
import { openAppVault } from "~/main/vault/safe-storage";
import { createMainWindow } from "~/main/window";
import { registerWindowIpc } from "~/main/window-ipc";
import { captureThemes, waitFor } from "../helpers/electron";
import {
  openLibrary,
  replaceSource,
  selectManagementView,
  selectSourceFile,
  sourceText,
} from "../helpers/module-source";

const managementRoute = /^#\/modules\/[^/]+$/;
const applicationRoute = /^#\/m\/[^/]+$/;

registerModuleScheme();
app.on("window-all-closed", () => undefined);
async function rebuild(window: BrowserWindow, source: string) {
  await selectManagementView(window, "Source");
  await replaceSource(
    window,
    source.replace("Edited and built in Works", "Rebuilt in Works")
  );
  await selectManagementView(window, "Releases");
  await waitFor(
    async () =>
      (await window.webContents.executeJavaScript(
        "Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Save source' && !button.disabled)"
      )) === true,
    "Second edit did not become dirty"
  );
  await window.webContents.executeJavaScript(
    "Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Build & preview').click()"
  );
  await waitFor(
    async () => {
      const status: string = await window.webContents.executeJavaScript(
        "document.querySelector('[role=status]')?.textContent ?? ''"
      );
      if (status.includes("failed") || status.includes("could not")) {
        throw new Error(status);
      }
      const frame = window.webContents.mainFrame.frames.find((candidate) =>
        candidate.url.startsWith("module-app://")
      );
      if (!frame) {
        return false;
      }
      return (
        (await frame.executeJavaScript(
          "document.querySelector('h1')?.textContent === 'Rebuilt in Works'"
        )) === true
      );
    },
    "Second build did not render its updated view",
    600_000
  );
}

async function smoke() {
  const [userData] = process.argv.slice(2);
  assert.ok(userData);
  app.setPath("userData", userData);
  await app.whenReady();
  const moduleRoot = path.join(userData, "foundry", "modules");
  const { library: modules, store } = await openLocalModuleLibrary(moduleRoot);
  const builds = new ModuleBuilds(
    modules,
    await createBuildRuntime(moduleRoot)
  );
  const sessions = new ModuleSessions(
    modules,
    await createModuleRuntime(moduleRoot, store)
  );
  registerModuleProtocol(sessions);
  registerRpcTransport({
    builds,
    modules,
    sessions,
    vault: await openAppVault(userData),
  });
  registerWindowIpc();
  const window = createMainWindow();
  try {
    await once(window.webContents, "did-finish-load", {
      signal: AbortSignal.timeout(10_000),
    });
    await openLibrary(window);
    await waitFor(
      async () =>
        await window.webContents.executeJavaScript(
          "!!document.querySelector('#module-name')"
        ),
      "Home did not load"
    );
    await window.webContents.executeJavaScript(`
      const name = document.querySelector('#module-name');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(name, 'Built in Works');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await waitFor(
      async () =>
        await window.webContents.executeJavaScript(
          "!!document.querySelector('button[type=submit]:not(:disabled)')"
        ),
      "Create remained disabled"
    );
    await window.webContents.executeJavaScript(
      "document.querySelector('form').requestSubmit()"
    );
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          "!!document.querySelector('[role=tab]')"
        ),
      "Creating a module did not open management"
    );
    assert.match(
      await window.webContents.executeJavaScript("location.hash"),
      managementRoute
    );
    await window.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('a')).find(link => link.textContent === 'Open app').click()"
    );
    assert.match(
      await window.webContents.executeJavaScript("location.hash"),
      applicationRoute
    );

    await waitFor(
      async () => {
        const failure: string | null =
          await window.webContents.executeJavaScript(
            "document.querySelector('[role=alert]')?.textContent ?? null"
          );
        if (failure) {
          throw new Error(failure);
        }
        const frame = window.webContents.mainFrame.frames.find((candidate) =>
          candidate.url.startsWith("module-app://")
        );
        if (!frame) {
          return false;
        }
        return (
          (await frame.executeJavaScript(
            "document.querySelector('h1')?.textContent === 'Built in Works'"
          )) === true
        );
      },
      "Creating a module did not automatically build and open its app",
      600_000
    );
    assert.equal(
      await window.webContents.executeJavaScript(
        "!!document.querySelector('[data-module-source]')"
      ),
      false,
      "Opening an app exposed its editor"
    );
    await captureThemes(window, "module-app");
    const appFrame = window.webContents.mainFrame.frames.find((candidate) =>
      candidate.url.startsWith("module-app://")
    );
    assert.ok(appFrame);
    assert.deepEqual(
      await appFrame.executeJavaScript(`(async () => {
      const response = await fetch('/_module/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'mutation { insertIntoNotesSingle(values: { body: "Keep my app data" }) { body } }' }) });
      return await response.json();
    })()`),
      { data: { insertIntoNotesSingle: { body: "Keep my app data" } } }
    );
    await window.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('a')).find(link => link.textContent === 'Manage module').click()"
    );
    await waitFor(
      async () =>
        await window.webContents.executeJavaScript(
          `(${sourceText}).includes("Built in Works")`
        ),
      "Starter source did not load"
    );
    const [createdModule] = await modules.list();
    assert.ok(createdModule);
    const initial = await modules.details(createdModule.id);
    const initialSource = initial?.source["packages/app/src/App.tsx"];
    assert.ok(initialSource);
    await selectSourceFile(window, "packages/app/src/main.tsx");
    await selectSourceFile(window, "packages/app/src/App.tsx");
    await replaceSource(
      window,
      initialSource.replace("Built in Works", "Edited and built in Works")
    );
    await selectManagementView(window, "Changes");
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          "Array.from(document.querySelectorAll('diffs-container')).some(host => host.shadowRoot?.textContent.includes('Edited and built in Works'))"
        ),
      "Pierre diff did not show the draft"
    );
    await captureThemes(window, "module-changes");
    await selectManagementView(window, "Source");
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          `(${sourceText}).includes("Edited and built in Works")`
        ),
      "Draft did not survive returning from Changes"
    );
    await selectSourceFile(window, "packages/app/src/main.tsx");
    await selectSourceFile(window, "packages/app/src/App.tsx");
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          `(${sourceText}).includes("Edited and built in Works")`
        ),
      "Draft did not survive switching files"
    );
    await captureThemes(window, "module-source");
    await selectManagementView(window, "Releases");
    await waitFor(
      async () =>
        await window.webContents.executeJavaScript(
          "Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Save source' && !button.disabled)"
        ),
      "Edited source did not become dirty"
    );
    await window.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Build & preview').click()"
    );
    let last = "";
    await waitFor(
      async () => {
        const status: string = await window.webContents.executeJavaScript(
          "document.querySelector('[role=status]')?.textContent ?? ''"
        );
        if (status !== last) {
          process.stdout.write(`${status.slice(0, 300)}\n`);
          last = status;
        }
        if (
          status.includes("failed") ||
          status.includes("could not") ||
          status.includes("require the")
        ) {
          throw new Error(status);
        }
        return await window.webContents.executeJavaScript(
          "!!document.querySelector('iframe')"
        );
      },
      "Build did not open its preview",
      600_000
    );
    await waitFor(
      async () => {
        const frame = window.webContents.mainFrame.frames.find((candidate) =>
          candidate.url.startsWith("module-app://")
        );
        if (!frame) {
          return false;
        }
        return (
          (await frame.executeJavaScript(
            "document.querySelector('h1')?.textContent === 'Edited and built in Works'"
          )) === true
        );
      },
      "Built view did not render",
      60_000
    );
    const frame = window.webContents.mainFrame.frames.find((candidate) =>
      candidate.url.startsWith("module-app://")
    );
    assert.ok(frame);
    assert.equal(
      await frame.executeJavaScript("typeof window.worksWindow"),
      "undefined"
    );
    await frame.executeJavaScript("document.querySelector('button').click()");
    await waitFor(
      async () =>
        (await frame.executeJavaScript(
          "document.querySelector('button').textContent === 'Count: 1'"
        )) === true,
      "Built React app did not hydrate"
    );
    const [module] = await modules.list();
    assert.ok(module);
    const details = await modules.details(module.id);
    assert.ok(details);
    const savedApp = details.source["packages/app/src/App.tsx"];
    assert.ok(savedApp);
    assert.ok(savedApp.includes("Edited and built in Works"));
    assert.ok(details.source["bun.lock"]);
    assert.equal(details.releases.length, 2);
    assert.equal(details.releases[0]?.tag, "0.1.1");
    assert.equal(
      (
        await (
          await openLocalModuleLibrary(moduleRoot)
        ).library.details(module.id)
      )?.releases.length,
      2
    );
    assert.ok(
      (
        await readFile(
          path.join(
            moduleRoot,
            moduleDirectory(module.id),
            "packages/app/src/App.tsx"
          ),
          "utf8"
        )
      ).includes("Edited and built in Works")
    );
    await rebuild(window, savedApp);
    const rebuilt = await modules.details(module.id);
    assert.equal(rebuilt?.releases.length, 3);
    assert.ok(rebuilt?.releases.some((release) => release.tag === "0.1.2"));
    const [firstRelease] = details.releases;
    assert.ok(firstRelease);
    assert.ok(await modules.release(module.id, firstRelease.contentId));
    const rebuiltFrame = window.webContents.mainFrame.frames.find((candidate) =>
      candidate.url.startsWith("module-app://")
    );
    assert.ok(rebuiltFrame);
    assert.deepEqual(
      await rebuiltFrame.executeJavaScript(`(async () => {
      const response = await fetch('/_module/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query { notes { body } }' }) });
      return await response.json();
    })()`),
      { data: { notes: [{ body: "Keep my app data" }] } }
    );
    await captureThemes(window, "module-build");
    window.close();
    process.stdout.write("Electron create/edit/build/preview passed\n");
  } finally {
    if (!window.isDestroyed()) {
      window.destroy();
    }
    await builds.shutdown();
    await sessions.shutdown();
  }
}
smoke()
  .then(() => app.quit())
  .catch((error: unknown) => {
    process.stderr.write(`Electron module build failed: ${String(error)}\n`);
    app.exit(1);
  });
