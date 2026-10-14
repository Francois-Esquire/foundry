import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModuleVersion } from "@foundry/modules/domain";
import type { ModuleRuntimeIdentity } from "@foundry/modules/gateway/types";
import type { StateStore } from "@foundry.sh/marbles/engine";
import { onTestFinished } from "vitest";
import { ARTIFACT_CAPABILITIES } from "~/main/artifacts/gateway/host";
import type { WatchedEntry } from "~/main/artifacts/gateway/watch";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import { publishStrict } from "./module-build";
import { composeTestWorks } from "./works";

/** A Markdown editor's Manifest: every Artifact operation, one write View. */
export const EDITOR_MANIFEST = {
  capabilities: [
    { alias: "binding", capability: ARTIFACT_CAPABILITIES.binding },
    { alias: "read", capability: ARTIFACT_CAPABILITIES.read },
    { alias: "save", capability: ARTIFACT_CAPABILITIES.save },
    {
      alias: "create",
      capability: ARTIFACT_CAPABILITIES.create,
      constraints: { maxBytes: 4096, mimeTypes: ["text/markdown"] },
    },
    { alias: "watch", capability: ARTIFACT_CAPABILITIES.watch },
  ].map((request) => ({
    ...request,
    reason: "Edits Markdown files",
    version: 1,
  })),
  editors: [
    { mimeTypes: ["text/markdown"], mode: "write", view: "editor" },
    { mimeTypes: ["text/markdown"], mode: "read", view: "preview" },
  ],
  views: {
    editor: { path: "/", title: "Markdown" },
    preview: { path: "/preview", title: "Preview" },
  },
};

/** The binding-scoped operations: every Artifact Capability but `list`. */
export const ALL = Object.values(ARTIFACT_CAPABILITIES).filter(
  (capability) => capability !== ARTIFACT_CAPABILITIES.list
);

export interface EditorHostOptions {
  /** Each new Module's setting values, chosen before its release. */
  readonly settings?: Readonly<Record<string, number>>;
  /** The engine's state store, under the host's `engine/` directory. */
  readonly state?: (directory: string) => StateStore;
}

/**
 * Works' editor host on real storage, composed as main composes it: the
 * Module library, ModuleStore, durable engine, product files, bindings,
 * settings, Access with every capability's Grant hooks, and the explorer.
 * Only the VM and Gateway socket are stand-ins (see {@link composeTestWorks}).
 * Closed when the test finishes.
 */
export async function editorHost(options: EditorHostOptions = {}) {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "works-editor-"))
  );
  const cleanups: (() => Promise<void>)[] = [
    () => rm(directory, { force: true, recursive: true }),
  ];
  onTestFinished(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });
  const { programs, works } = await composeTestWorks(
    directory,
    options.state ? { state: options.state } : {}
  );
  cleanups.push(() => works.close());
  const { invocations, programs: supervisor } = programs;
  const { access } = works.rpc;
  const { bindings, execution, files } = works.testing;
  const explorer = works.rpc.artifacts;
  let requests = 0;

  /** A Module with the editor released, approved and running. */
  async function editorApp(
    name = "Markdown",
    grants: readonly string[] = ALL,
    manifest: object = EDITOR_MANIFEST
  ) {
    const module = await works.rpc.modules.create(name);
    if (options.settings) {
      await works.rpc.moduleSettings.set(module.id, options.settings);
    }
    const version = await publishStrict(
      works.rpc.modules,
      module.id,
      "1.0.0",
      manifest
    );
    for (const capability of grants) {
      await access.approve(module.id, capability);
    }
    return { module, version, ...(await start(version)) };
  }

  async function start(version: ModuleVersion) {
    const app = await works.testing.runtime.start(
      version,
      new AbortController().signal
    );
    const runtime = await supervisor.active(
      moduleInstallationId(version.moduleId)
    );
    if (!runtime) {
      throw new Error("Program not active");
    }
    return { app, runtime };
  }

  function call<T>(
    target: { runtime: ModuleRuntimeIdentity; version: ModuleVersion },
    alias: string,
    input: unknown
  ): Promise<T> {
    requests += 1;
    return invocations
      .dispatch({
        capabilities: target.version.manifest.capabilities,
        request: {
          alias,
          id: String(requests),
          input,
          kind: "invoke",
          mode: "unary",
        },
        runtime: target.runtime,
        signal: new AbortController().signal,
      })
      .then((result) => {
        if (result.mode !== "unary") {
          throw new Error("expected unary");
        }
        return result.output as T;
      });
  }

  async function watch(
    target: { runtime: ModuleRuntimeIdentity; version: ModuleVersion },
    input: unknown,
    signal = new AbortController().signal
  ): Promise<AsyncIterator<WatchedEntry>> {
    requests += 1;
    const result = await invocations.dispatch({
      capabilities: target.version.manifest.capabilities,
      request: {
        alias: "watch",
        id: String(requests),
        input,
        kind: "invoke",
        mode: "stream",
      },
      runtime: target.runtime,
      signal,
    });
    if (result.mode !== "stream") {
      throw new Error("expected stream");
    }
    return (result.events as AsyncIterable<WatchedEntry>)[
      Symbol.asyncIterator
    ]();
  }

  /** The host opening a File Artifact in an editor View, as Artifacts does. */
  async function openIn(artifactId: string, moduleId: string, view: string) {
    const resolved = await explorer.resolve({ id: artifactId });
    if (resolved.kind !== "editors") {
      throw new Error(`expected editors, got ${resolved.kind}`);
    }
    return explorer.open({
      contentId: resolved.contentId,
      entry: resolved.entry.path,
      id: artifactId,
      moduleId,
      view,
    });
  }

  async function markdownFile(name: string, text: string) {
    const created = await files.create({
      actor: { kind: "user" },
      bytes: new TextEncoder().encode(text),
      mime: "text/markdown",
      name,
      path: `${name}.md`,
    });
    if (created.kind !== "created") {
      throw new Error(created.reason);
    }
    return created;
  }

  return {
    access,
    bindings,
    call,
    directory,
    editorApp,
    execution,
    explorer,
    files,
    markdownFile,
    openIn,
    /** The shared manager and ModuleStore Works composed. */
    persistence: works.testing.persistence,
    start,
    watch,
    works,
  };
}

export interface Bound {
  artifactId: string;
  contentId: string;
  entry: { digest: string; path: string };
  mode: "read" | "write";
}
export interface Read {
  data: string;
  digest: string;
  next: number | null;
}
export interface Saved {
  digest?: string;
  kind: string;
  retried?: boolean;
}

export async function readAll(
  call: <T>(alias: string, input: unknown) => Promise<T>,
  binding: string
) {
  const parts: Buffer[] = [];
  let offset: number | null = 0;
  let digest = "";
  let chunks = 0;
  while (offset !== null) {
    const read: Read = await call<Read>("read", { binding, offset });
    parts.push(Buffer.from(read.data, "base64"));
    ({ digest } = read);
    offset = read.next;
    chunks += 1;
  }
  return { chunks, digest, text: Buffer.concat(parts).toString("utf8") };
}
