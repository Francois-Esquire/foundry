import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import { boundViewUrl } from "~/app/artifacts/open-editor";
import { ARTIFACT_CAPABILITIES } from "~/main/artifacts/gateway/host";
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

/**
 * The core Markdown fixture, imported from its built package (not
 * preinstalled), runs under Microsandbox and opens a Markdown File Artifact
 * in a sandboxed View through its host-owned binding: it reads, saves,
 * reopens, follows a save made elsewhere, keeps an unsaved Draft against a
 * newer save and reports the stale save as a conflict.
 */
async function smoke(userData: string) {
  const works = await smokeWorks(userData);
  const { access, sessions } = works.rpc;
  const { files } = works.testing;
  const library = works.rpc.modules;
  const explorer = works.rpc.artifacts;
  registerModuleProtocol(sessions);

  const imported = await library.importPackage(
    await readFile(FIXTURE_PACKAGE, "utf8")
  );
  const contentId = (await library.details(imported.id))?.releases[0]
    ?.contentId;
  assert.ok(contentId, "Imported release missing");
  for (const capability of Object.values(ARTIFACT_CAPABILITIES)) {
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
  if (notes.kind !== "created") {
    return;
  }
  const open = async () => {
    const resolved = await explorer.resolve({ id: notes.artifactId });
    assert.equal(resolved.kind, "editors");
    assert.ok(resolved.kind === "editors");
    assert.deepEqual(
      resolved.candidates.map((candidate) => candidate.moduleId),
      [imported.id]
    );
    return explorer.open({
      contentId: resolved.contentId,
      entry: resolved.entry.path,
      id: notes.artifactId,
      moduleId: imported.id,
      view: "editor",
    });
  };
  const savedText = async () => {
    const chunk = await files.read(notes.artifactId, "smoke.md", {
      length: 65_536,
      offset: 0,
    });
    return new TextDecoder().decode(chunk?.data);
  };

  const watch = sessions.watch(imported.id, contentId);
  const windows: BrowserWindow[] = [];
  const results: string[] = [];
  try {
    const { value } = await watch.next();
    assert.ok(value, "The app did not start");
    const view = value.views.find((candidate) => candidate.id === "editor");
    assert.ok(view);

    /** A sandboxed window on the editor View, opened with one binding. */
    const show = async (binding: string) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      windows.push(window);
      await window.loadURL(boundViewUrl(value.origin, view.path, binding));
      const evaluate = <T>(code: string): Promise<T> =>
        window.webContents.executeJavaScript(code) as Promise<T>;
      await waitFor(
        () => evaluate<boolean>('document.body?.dataset.ready === "true"'),
        "The editor View did not load",
        30_000
      );
      return evaluate;
    };
    const textOf = (evaluate: <T>(code: string) => Promise<T>) =>
      evaluate<string>("document.getElementById('text').value");
    const type = (evaluate: <T>(code: string) => Promise<T>, text: string) =>
      evaluate(
        `(() => { const area = document.getElementById('text'); area.value = ${JSON.stringify(text)}; area.dispatchEvent(new Event('input')); })()`
      );
    const status = (evaluate: <T>(code: string) => Promise<T>) =>
      evaluate<string>("document.getElementById('status').textContent");

    // Read through the binding the host opened the View with.
    const first = await open();
    const editor = await show(first.binding);
    assert.equal(await textOf(editor), "# Smoke\n");
    results.push(`opened ${first.entry} through binding (read)`);

    // Save in place.
    await type(editor, "# Smoke\n\nSaved from the sandboxed View.\n");
    await editor("document.getElementById('save').click()");
    await waitFor(
      async () =>
        (await status(editor)) === "Saved" &&
        (await editor<string>("document.body.dataset.dirty")) === "false",
      "The View did not save",
      20_000
    );
    assert.equal(
      await savedText(),
      "# Smoke\n\nSaved from the sandboxed View.\n"
    );
    const contents = await works.testing.persistence.artifacts.listContents(
      notes.artifactId as never
    );
    assert.deepEqual(
      contents.map((content) => [content.id, content.state]),
      [[notes.contentId, "ready"]]
    );
    results.push("save: committed in place (same ready Content)");

    // Reopen through a fresh binding.
    const second = await open();
    assert.notEqual(second.binding, first.binding);
    const reopened = await show(second.binding);
    assert.equal(
      await textOf(reopened),
      "# Smoke\n\nSaved from the sandboxed View.\n"
    );
    results.push("reopen: a second binding on the same runtime reads it");

    // A save made elsewhere reaches the clean View through its watch.
    const base = await editor<string>("document.body.dataset.digest");
    const elsewhere = await files.save({
      actor: { kind: "user" },
      artifactId: notes.artifactId,
      expectedDigest: base,
      path: "smoke.md",
      text: "# Smoke\n\nSaved elsewhere.\n",
    });
    assert.equal(elsewhere.kind, "saved");
    await waitFor(
      async () => (await textOf(editor)) === "# Smoke\n\nSaved elsewhere.\n",
      "The clean View did not follow the newer save",
      20_000
    );
    results.push("watch: clean View reloaded the newer save");

    // With unsaved edits, a newer save is surfaced and the Draft is kept.
    await type(editor, "My unsaved Draft\n");
    const latest = await editor<string>("document.body.dataset.digest");
    assert.equal(
      (
        await files.save({
          actor: { kind: "user" },
          artifactId: notes.artifactId,
          expectedDigest: latest,
          path: "smoke.md",
          text: "# Smoke\n\nSaved elsewhere again.\n",
        })
      ).kind,
      "saved"
    );
    await waitFor(
      async () =>
        (await editor<string>("document.body.dataset.newer")) === "true",
      "The dirty View did not surface the newer save",
      20_000
    );
    assert.equal(await textOf(editor), "My unsaved Draft\n");
    results.push(
      "watch: dirty View kept its Draft and surfaced the newer base"
    );

    // Saving that Draft is stale: a conflict, nothing overwritten.
    await editor("document.getElementById('save').click()");
    await waitFor(
      async () =>
        (await editor<string>("document.body.dataset.conflict")) === "true",
      "The stale save did not report a conflict",
      20_000
    );
    assert.equal(await savedText(), "# Smoke\n\nSaved elsewhere again.\n");
    assert.equal(await textOf(editor), "My unsaved Draft\n");
    results.push("stale save: conflict, both versions kept");

    process.stdout.write(
      `Electron module editor passed (Microsandbox):\n  ${results.join("\n  ")}\n`
    );
  } finally {
    for (const window of windows) {
      window.destroy();
    }
    await watch.return();
    await works.close();
  }
}

runElectronSmoke("module editor", smoke);
