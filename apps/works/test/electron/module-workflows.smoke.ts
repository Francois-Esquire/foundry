import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import { ARTIFACT_CAPABILITIES } from "~/main/artifacts/gateway/host";
import { EXECUTION_CAPABILITIES } from "~/main/execution/capabilities";
import {
  registerModuleProtocol,
  registerModuleScheme,
} from "~/main/modules/runtime/protocol";
import { runElectronSmoke, waitFor } from "../helpers/electron";
import { smokeWorks } from "../helpers/smoke-works";

registerModuleScheme();

/** Built by `bun run build` in modules/markdown-fixture. */
const FIXTURE_PACKAGE = path.resolve(
  "../../modules/markdown-fixture/dist/markdown-fixture.module.json"
);
const TICKER = "works.examples.ticker@1";

/**
 * The core fixture's Workflows View, under Microsandbox, starts, follows and
 * cancels the host-registered ticker workflow and lists Markdown files in its
 * approved scope, all through its Program and the Gateway, in Works as main
 * composes it. Revoking Grants with the Access service (what the Catalog
 * Access panel calls) cancels the running workflow, refuses new starts, and
 * ends the broader file scope.
 */
async function smoke(userData: string) {
  const works = await smokeWorks(userData);
  const { access, sessions } = works.rpc;
  const { execution, files } = works.testing;
  const library = works.rpc.modules;
  registerModuleProtocol(sessions);

  const imported = await library.importPackage(
    await readFile(FIXTURE_PACKAGE, "utf8")
  );
  const contentId = (await library.details(imported.id))?.releases[0]
    ?.contentId;
  assert.ok(contentId, "Imported release missing");
  for (const capability of [
    ...Object.values(ARTIFACT_CAPABILITIES),
    ...Object.values(EXECUTION_CAPABILITIES),
  ]) {
    await access.approve(imported.id, capability);
  }
  const notes = await files.create({
    actor: { kind: "user" },
    bytes: new TextEncoder().encode("# Smoke\n"),
    mime: "text/markdown",
    name: "Smoke notes",
    path: "smoke.md",
  });
  assert.equal(notes.kind, "created");

  const watch = sessions.watch(imported.id, contentId);
  const results: string[] = [];
  let window: BrowserWindow | undefined;
  try {
    const { value } = await watch.next();
    assert.ok(value, "The app did not start");
    const view = value.views.find((candidate) => candidate.id === "workflows");
    assert.ok(view, "The Workflows View is missing");
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await window.loadURL(`${value.origin}${view.path}`);
    const page = window;
    const evaluate = <T>(code: string): Promise<T> =>
      page.webContents.executeJavaScript(code) as Promise<T>;
    const data = (key: string) =>
      evaluate<string | undefined>(`document.body.dataset.${key}`);
    const click = (id: string) =>
      evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    const ticker = async (count: number, intervalMs: number) => {
      await evaluate(
        `(() => { document.getElementById('count').value = '${count}'; document.getElementById('interval').value = '${intervalMs}'; })()`
      );
      await click("ticker");
    };
    await waitFor(
      async () => (await data("ready")) === "true",
      "The Workflows View did not load",
      30_000
    );

    // The approved scope lists the Markdown file.
    await click("list");
    await waitFor(
      async () => (await data("files")) === "1",
      "The View did not list the Markdown file in its scope",
      20_000
    );
    results.push("list: the approved scope lists 1 Markdown file");

    // Start, follow to the end.
    await ticker(3, 50);
    await waitFor(
      async () => (await data("status")) === "complete",
      "The ticker did not complete",
      20_000
    );
    assert.equal(await data("tick"), "3");
    const completed = execution.runs.get((await data("execution")) ?? "");
    assert.equal(completed?.name, TICKER);
    assert.equal(completed?.correlation.moduleId, imported.id);
    assert.equal(completed?.queue, `module/${imported.id}/workflows`);
    results.push(
      "start + watch: ticker ran to complete (3 ticks) on the Module's workflows queue"
    );

    // Start, then cancel from the View.
    await ticker(50, 500);
    await waitFor(
      async () =>
        (await data("status")) === "running" && Number(await data("tick")) >= 1,
      "The long ticker did not report progress",
      20_000
    );
    await click("cancel");
    await waitFor(
      async () => (await data("status")) === "cancelled",
      "The View did not see its cancel",
      20_000
    );
    const cancelled = await data("execution");
    assert.equal(execution.runs.get(cancelled ?? "")?.status, "cancelled");
    results.push("cancel: the View cancelled its run through the engine");

    // Revoking the start Grant cancels a running workflow and refuses more.
    await ticker(50, 500);
    await waitFor(
      async () =>
        (await data("status")) === "running" && Number(await data("tick")) >= 1,
      "The ticker did not start before the revoke",
      20_000
    );
    const running = await data("execution");
    assert.notEqual(running, cancelled);
    await access.revoke(imported.id, EXECUTION_CAPABILITIES.start);
    assert.equal(execution.runs.get(running ?? "")?.status, "cancelled");
    await waitFor(
      async () => (await data("status")) === "cancelled",
      "The View did not see the revoke cancel its run",
      20_000
    );
    await ticker(1, 0);
    await waitFor(
      async () => (await data("error")) === "unauthorized",
      "A start after the revoke was not refused",
      20_000
    );
    results.push(
      "revoke start: running workflow cancelled, View saw it, next start unauthorized"
    );

    // Revoking the broader scope ends listing.
    await access.revoke(imported.id, ARTIFACT_CAPABILITIES.list);
    await evaluate("document.body.dataset.error = ''");
    await click("list");
    await waitFor(
      async () => (await data("error")) === "unauthorized",
      "Listing after the revoke was not refused",
      20_000
    );
    results.push("revoke list: the View's listing is refused");

    process.stdout.write(
      `Electron module workflows passed (Microsandbox):\n  ${results.join("\n  ")}\n`
    );
  } finally {
    window?.destroy();
    await watch.return();
    await works.close();
  }
}

runElectronSmoke("module workflows", smoke);
