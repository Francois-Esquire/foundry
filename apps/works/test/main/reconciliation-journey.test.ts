import type { ModuleGatewayError } from "@foundry/modules/gateway/types";
import { expect, it } from "vitest";
import type { FileSaveResult } from "~/main/artifacts/files";
import { ARTIFACT_CAPABILITIES } from "~/main/artifacts/gateway/host";
import type { WatchedEntry } from "~/main/artifacts/gateway/watch";
import { auditRun } from "~/main/execution/audit";
import { artifactSaves, failedSaveAttempt } from "~/shared/audit";
import { WORKS_TASKS } from "~/shared/execution";
import { editorHost, readAll } from "../helpers/editor-host";
import { FlakyJsonStateStore } from "../helpers/flaky-state";
import { COMPOSED_WORKS_TIMEOUT_MS } from "../helpers/works";

interface Created {
  artifactId: string;
  binding: string;
  contentId: string;
  digest: string;
  path: string;
}

type GatewaySave = FileSaveResult & { kind: string };

it("reconciles fixture and human edits of one File Artifact through create, watch, conflict, reconnect, recovery, frozen reopen and revoke", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, async () => {
  let state: FlakyJsonStateStore | undefined;
  const host = await editorHost({
    state: (directory) => {
      state = new FlakyJsonStateStore(`${directory}/state`);
      return state;
    },
  });
  const {
    access,
    call,
    editorApp,
    execution,
    files,
    openIn,
    watch,
    persistence,
  } = host;
  if (!state) {
    throw new Error("state store missing");
  }
  const app = await editorApp();
  const as = <T>(alias: string, input: unknown) => call<T>(app, alias, input);
  const human = { kind: "user" } as const;

  const created = await as<Created>("create", {
    content: "# Journey\n",
    mime: "text/markdown",
    name: "Journey",
    path: "journey.md",
    request: "create-1",
  });
  const { artifactId } = created;
  const base = await readAll(as, created.binding);
  expect(base.text).toBe("# Journey\n");

  const stream = await watch(app, { binding: created.binding });
  expect((await stream.next()).value).toMatchObject({
    entry: { digest: base.digest, path: "journey.md" },
    gap: false,
    kind: "snapshot",
  });

  const humanText = "# Journey\n\nTyped by a person.\n";
  const fixtureText = "# Journey\n\nWritten by the fixture.\n";
  const [byHuman, byFixture] = await Promise.all([
    files.save({
      actor: human,
      artifactId,
      expectedDigest: base.digest,
      path: "journey.md",
      text: humanText,
    }),
    as<GatewaySave>("save", {
      binding: created.binding,
      expectedDigest: base.digest,
      request: "race-1",
      text: fixtureText,
    }),
  ]);
  const outcomes = [byHuman.kind, byFixture.kind].sort();
  expect(outcomes).toEqual(["conflict", "saved"]);
  const winner = byHuman.kind === "saved" ? humanText : fixtureText;
  const loser = byHuman.kind === "saved" ? byFixture : byHuman;
  expect(loser).toMatchObject({ current: { text: winner }, kind: "conflict" });
  expect((await readAll(as, created.binding)).text).toBe(winner);

  const change = (await stream.next()).value as WatchedEntry;
  expect(change.kind).toBe("change");
  const seen = change.entry?.digest;
  expect(seen).not.toBe(base.digest);

  const merged = `${winner}\n${byHuman.kind === "saved" ? fixtureText : humanText}`;
  const resolved =
    byHuman.kind === "saved"
      ? await as<GatewaySave>("save", {
          binding: created.binding,
          expectedDigest: seen,
          request: "race-1-resolved",
          text: merged,
        })
      : await files.save({
          actor: human,
          artifactId,
          expectedDigest: seen ?? "",
          path: "journey.md",
          text: merged,
        });
  expect(resolved).toMatchObject({ evidence: "recorded", kind: "saved" });
  const latest = (await stream.next()).value as WatchedEntry;
  expect(latest.entry?.digest).not.toBe(seen);
  await stream.return?.();

  const again = await watch(app, {
    after: { contentId: created.contentId, digest: seen },
    binding: created.binding,
  });
  expect((await again.next()).value).toMatchObject({
    entry: { digest: latest.entry?.digest },
    gap: true,
    kind: "snapshot",
  });
  await again.return?.();

  state.failing = true;
  const unrecorded = await as<GatewaySave>("save", {
    binding: created.binding,
    expectedDigest: latest.entry?.digest,
    request: "unrecorded-1",
    text: `${merged}\nSaved while the run store was full.\n`,
  });
  expect(unrecorded).toMatchObject({
    evidence: "recovery-required",
    kind: "saved",
  });
  const blocked = await readAll(as, created.binding);
  expect(
    await files.save({
      actor: human,
      artifactId,
      expectedDigest: blocked.digest,
      path: "journey.md",
      text: "must wait",
    })
  ).toMatchObject({ kind: "refused" });
  expect((await readAll(as, created.binding)).text).toBe(blocked.text);
  state.failing = false;
  expect(
    await files.save({
      actor: human,
      artifactId,
      expectedDigest: blocked.digest,
      path: "journey.md",
      text: `${blocked.text}\nAfter recovery.\n`,
    })
  ).toMatchObject({ evidence: "recorded", kind: "saved" });

  const frozenId = (await persistence.artifacts.get(artifactId as never))
    ?.contentId;
  if (!frozenId) {
    throw new Error("no Content");
  }
  await persistence.artifacts.freeze(frozenId);
  const opened = await openIn(artifactId, app.module.id, "editor");
  expect(opened.contentId).not.toBe(frozenId);
  const states = async () =>
    (await persistence.artifacts.listContents(artifactId as never))
      .map((content) => [content.id, content.state])
      .sort();
  expect(await states()).toEqual(
    [
      [frozenId, "frozen"],
      [opened.contentId, "ready"],
    ].sort()
  );
  const reopenedBase = await readAll(as, opened.binding);
  expect(
    await as<GatewaySave>("save", {
      binding: opened.binding,
      expectedDigest: reopenedBase.digest,
      request: "after-freeze",
      text: "# Journey\n\nEdited after the freeze.\n",
    })
  ).toMatchObject({ contentId: opened.contentId, kind: "saved" });
  const reopened = await openIn(artifactId, app.module.id, "editor");
  expect(reopened.contentId).toBe(opened.contentId);
  expect(await states()).toHaveLength(2);

  const live = await watch(app, { binding: opened.binding });
  await live.next();
  const ended = live.next();
  await access.revoke(app.module.id, ARTIFACT_CAPABILITIES.binding);
  expect((await ended).done).toBe(true);
  await expect(
    as("read", { binding: opened.binding, offset: 0 })
  ).rejects.toMatchObject({
    code: "unauthorized",
  } satisfies Partial<ModuleGatewayError>);
  await expect(
    as("save", {
      binding: opened.binding,
      expectedDigest: reopenedBase.digest,
      request: "after-revoke",
      text: "refused",
    })
  ).rejects.toMatchObject({ code: "unauthorized" });

  const runs = execution.runs.list().map(auditRun);
  const saves = artifactSaves(runs).filter(
    (row) => row.artifactId === artifactId
  );
  expect(
    saves
      .map((row) => [row.action, row.origin, row.recoveredFrom !== undefined])
      .reverse()
  ).toEqual([
    ["created", "module", false],
    ["saved", byHuman.kind === "saved" ? "user" : "module", false],
    ["saved", byHuman.kind === "saved" ? "module" : "user", false],
    ["saved", "module", true],
    ["saved", "user", false],
    ["saved", "module", false],
  ]);
  const attempts = runs
    .map((run) => failedSaveAttempt(run))
    .filter((attempt) => attempt !== null);
  expect(attempts).toEqual(["conflict"]);
  const revisions = runs.filter((run) => run.name === WORKS_TASKS.fileRevise);
  expect(revisions).toHaveLength(1);
  expect(saves.map((row) => row.runId)).not.toContain(revisions[0]?.id);
});
