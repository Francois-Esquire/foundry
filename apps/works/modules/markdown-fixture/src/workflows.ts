import { serverSentEvents } from "./events";

/**
 * The fixture's Workflows View: it starts host-registered workflows, follows
 * and cancels them, and lists Markdown files in its approved scope to
 * summarize one. Its Program relays each request to Works, which runs the
 * workflow on the host with the host's own credentials.
 */

interface Execution {
  readonly error: { readonly code: string; readonly message?: string } | null;
  readonly execution: string;
  readonly output: unknown;
  readonly progress: { readonly count?: number; readonly tick?: number } | null;
  readonly status: string;
  readonly workflow: string;
}

interface Listed {
  readonly items: readonly {
    readonly artifactId: string;
    readonly name: string;
  }[];
  readonly next: string | null;
}

const SETTLED = new Set(["complete", "failed", "cancelled", "interrupted"]);

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const statusView = element<HTMLParagraphElement>("status");
const runView = element<HTMLParagraphElement>("run");
const cancelButton = element<HTMLButtonElement>("cancel");
const filesView = element<HTMLUListElement>("files");
const summaryView = element<HTMLParagraphElement>("summary");

let current: string | undefined;

async function request<T>(
  path: string,
  alias: string,
  input: unknown
): Promise<T> {
  const response = await fetch(path, {
    body: JSON.stringify({ alias, input }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const answer = (await response.json()) as
    | { code: string; ok: false }
    | { ok: true; output: T };
  if (!answer.ok) {
    throw new Error(answer.code);
  }
  return answer.output;
}

function report(message: string, error?: string): void {
  statusView.textContent = message;
  document.body.dataset.error = error ?? "";
}

function show(run: Execution): void {
  const { progress, status } = run;
  const ticks =
    progress?.tick === undefined
      ? ""
      : ` · tick ${progress.tick} of ${progress.count}`;
  runView.textContent = `${run.workflow}: ${status}${ticks}`;
  cancelButton.disabled = SETTLED.has(status);
  document.body.dataset.status = status;
  document.body.dataset.tick = String(progress?.tick ?? 0);
  const summary = (run.output as { summary?: unknown } | null)?.summary;
  if (status === "complete" && typeof summary === "string") {
    summaryView.textContent = summary;
  }
  if (run.error) {
    report(`The workflow ${status}: ${run.error.message ?? run.error.code}`);
  }
}

/** Follow one execution until it settles; a dropped watch reconnects for a fresh snapshot. */
async function follow(execution: string): Promise<void> {
  for (;;) {
    let heard = false;
    try {
      const response = await fetch(
        `/_module/execution/watch?${new URLSearchParams({ execution })}`,
        { headers: { accept: "text/event-stream" } }
      );
      for await (const run of serverSentEvents<Execution>(response)) {
        heard = true;
        if (current !== execution) {
          return;
        }
        show(run);
        if (SETTLED.has(run.status)) {
          return;
        }
      }
    } catch {
      // Reconnect below.
    }
    if (!heard) {
      // Refused (or no host): stop rather than retry forever.
      document.body.dataset.status = "unwatched";
      report("This app can no longer follow the workflow");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function start(workflow: string, input: unknown): Promise<void> {
  report("Starting…");
  current = undefined;
  cancelButton.disabled = true;
  document.body.dataset.status = "starting";
  document.body.dataset.tick = "0";
  try {
    const started = await request<{ execution: string; status: string }>(
      "/_module/execution",
      "start",
      { input, request: crypto.randomUUID(), version: 1, workflow }
    );
    current = started.execution;
    document.body.dataset.execution = started.execution;
    report("Started");
    await follow(started.execution);
  } catch (error) {
    report(
      `Could not start: ${(error as Error).message}`,
      (error as Error).message
    );
  }
}

/** A Markdown file in scope, read whole by its id. */
async function readText(artifactId: string): Promise<string> {
  const parts: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const read: { data: string; next: number | null } = await request(
      "/_module/artifacts",
      "read",
      { artifactId, offset }
    );
    parts.push(read.data);
    offset = read.next;
  }
  const bytes = parts.flatMap((part) =>
    Array.from(atob(part), (character) => character.charCodeAt(0))
  );
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

async function list(): Promise<void> {
  try {
    const listed = await request<Listed>("/_module/artifacts", "files", {});
    filesView.replaceChildren(
      ...listed.items.map(({ artifactId, name }) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `Summarize ${name}`;
        button.dataset.artifact = artifactId;
        button.addEventListener("click", () => {
          summaryView.textContent = "";
          readText(artifactId)
            .then((text) => start("works.text.summarize", { text }))
            .catch((error: Error) =>
              report(`Could not read ${name}: ${error.message}`, error.message)
            );
        });
        item.append(button);
        return item;
      })
    );
    document.body.dataset.files = String(listed.items.length);
    report(`${listed.items.length} Markdown files`);
  } catch (error) {
    filesView.replaceChildren();
    document.body.dataset.files = "";
    report(
      `Could not list files: ${(error as Error).message}`,
      (error as Error).message
    );
  }
}

element("ticker").addEventListener("click", () => {
  start("works.examples.ticker", {
    count: element<HTMLInputElement>("count").valueAsNumber,
    intervalMs: element<HTMLInputElement>("interval").valueAsNumber,
  }).catch(() => undefined);
});
cancelButton.addEventListener("click", () => {
  if (current) {
    request("/_module/execution", "cancel", { execution: current }).catch(
      (error: Error) =>
        report(`Could not cancel: ${error.message}`, error.message)
    );
  }
});
element("list").addEventListener("click", () => {
  list().catch(() => undefined);
});
document.body.dataset.ready = "true";
