import {
  answered,
  type Draft,
  dirty,
  edit,
  keepMine,
  observed,
  opened,
  reloaded,
  type SaveAnswer,
  type SavedBase,
  takeTheirs,
  type WatchEvent,
} from "./draft";
import { serverSentEvents } from "./events";

/**
 * The Documents Module's View. It knows only the binding in its URL; its
 * Program relays each request to Works, which checks it against this app's
 * runtime and Grants.
 */

interface Bound {
  readonly binding: string;
  readonly contentId: string;
  readonly entry: { readonly digest: string; readonly path: string };
  readonly mode: "read" | "write";
  readonly name: string;
}

const RECONNECT_MS = 1000;

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const nameView = element<HTMLHeadingElement>("name");
const statusView = element<HTMLParagraphElement>("status");
const textView = element<HTMLTextAreaElement>("text");
const saveButton = element<HTMLButtonElement>("save");
const createView = element<HTMLElement>("create");
const newerView = element<HTMLElement>("newer");
const conflictView = element<HTMLElement>("conflict");
const theirsView = element<HTMLPreElement>("theirs");

let binding = new URLSearchParams(location.search).get("binding");
let bound: Bound | undefined;
let draft: Draft | undefined;
let saving = false;

async function call<T>(alias: string, input: unknown): Promise<T> {
  const response = await fetch("/_module/artifacts", {
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

/** The whole entry, chunk by chunk; starts over if it changes mid-read. */
async function readAll(): Promise<{ digest: string; text: string }> {
  for (;;) {
    const parts: Uint8Array[] = [];
    let offset: number | null = 0;
    let digest: string | undefined;
    let changed = false;
    while (offset !== null) {
      const read: {
        data: string;
        digest: string;
        next: number | null;
      } = await call("read", { binding, offset });
      changed ||= digest !== undefined && digest !== read.digest;
      ({ digest } = read);
      parts.push(Uint8Array.from(atob(read.data), (c) => c.charCodeAt(0)));
      offset = read.next;
    }
    if (!changed && digest !== undefined) {
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      return { digest, text: new TextDecoder().decode(bytes) };
    }
  }
}

function render(message?: string): void {
  const writable = bound?.mode === "write";
  createView.hidden = binding !== null;
  textView.hidden = !draft;
  textView.readOnly = !writable;
  saveButton.hidden = !writable;
  saveButton.disabled = !(draft && writable && dirty(draft)) || saving;
  newerView.hidden = !draft?.newer;
  conflictView.hidden = !draft?.conflict;
  theirsView.textContent = draft?.conflict?.text ?? "";
  if (draft && textView.value !== draft.text) {
    textView.value = draft.text;
  }
  if (message !== undefined) {
    statusView.textContent = message;
  }
  document.body.dataset.dirty = String(draft ? dirty(draft) : false);
  document.body.dataset.digest = draft?.base.digest ?? "";
  document.body.dataset.conflict = String(Boolean(draft?.conflict));
  document.body.dataset.newer = String(Boolean(draft?.newer));
}

async function open(): Promise<void> {
  bound = await call<Bound>("binding", { binding });
  nameView.textContent = bound.name;
  const { digest, text } = await readAll();
  draft = opened({ contentId: bound.contentId, digest }, text);
  render(bound.mode === "write" ? "Saved" : "Read only");
  document.body.dataset.ready = "true";
  watch(draft.base).catch(() => undefined);
}

async function reload(base: SavedBase): Promise<void> {
  if (base.contentId !== bound?.contentId) {
    bound = await call<Bound>("binding", { binding, refresh: true });
  }
  const { digest, text } = await readAll();
  if (draft) {
    draft = reloaded(draft, { contentId: base.contentId, digest }, text);
  }
  render("Updated from a newer save");
}

/** Apply one watch event; false once the file is gone. */
async function apply(event: WatchEvent): Promise<boolean> {
  if (!draft) {
    return false;
  }
  const next = observed(draft, event);
  ({ draft } = next);
  if (next.removed) {
    render("This file was removed. Your text is still here.");
    return false;
  }
  if (next.reload) {
    await reload(next.reload);
  } else {
    render();
  }
  return true;
}

/** Follows the bound entry; reconnects with what it last saw. */
async function watch(after: SavedBase): Promise<void> {
  let last = after;
  for (;;) {
    const query = new URLSearchParams({
      binding: binding ?? "",
      contentId: last.contentId,
      digest: last.digest,
    });
    try {
      const response = await fetch(`/_module/artifacts/watch?${query}`, {
        headers: { accept: "text/event-stream" },
      });
      for await (const event of serverSentEvents<WatchEvent>(response)) {
        if (event.contentId && event.entry) {
          last = { contentId: event.contentId, digest: event.entry.digest };
        }
        if (!(await apply(event))) {
          return;
        }
      }
    } catch {
      // Reconnect below.
    }
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
  }
}

async function save(): Promise<void> {
  if (!draft || saving) {
    return;
  }
  saving = true;
  const sent = draft.text;
  render("Saving…");
  try {
    const answer = await call<SaveAnswer>("save", {
      binding,
      expectedDigest: draft.base.digest,
      request: crypto.randomUUID(),
      text: sent,
    });
    draft = answered(draft, sent, answer);
    render(saveMessage(answer));
  } catch (error) {
    render(`Not saved: ${(error as Error).message}`);
  } finally {
    saving = false;
    render();
  }
}

function saveMessage(answer: SaveAnswer): string {
  if (answer.kind === "saved") {
    return "Saved";
  }
  if (answer.kind === "conflict") {
    return "Not saved: this file changed elsewhere";
  }
  return `Not saved: ${"reason" in answer && answer.reason ? answer.reason : answer.kind}`;
}

async function create(): Promise<void> {
  const created = await call<{ binding: string }>("create", {
    content: "# Untitled\n",
    mime: "text/markdown",
    name: "Untitled",
    path: "untitled.md",
    request: crypto.randomUUID(),
  });
  ({ binding } = created);
  history.replaceState(null, "", `?binding=${encodeURIComponent(binding)}`);
  await open();
}

textView.addEventListener("input", () => {
  if (draft) {
    draft = edit(draft, textView.value);
    render();
  }
});
saveButton.addEventListener("click", () => {
  save().catch(() => undefined);
});
element("reload").addEventListener("click", () => {
  const newer = draft?.newer;
  if (newer && draft) {
    draft = { ...draft, conflict: null, saved: draft.text };
    reload(newer).catch(() => render("Could not load the newer version"));
  }
});
element("keep").addEventListener("click", () => {
  if (draft) {
    draft = keepMine(draft);
    render("Keeping your version: save to replace the other one");
  }
});
element("take").addEventListener("click", () => {
  if (draft) {
    draft = takeTheirs(draft);
    render("Showing the saved version");
  }
});
element("new").addEventListener("click", () => {
  create().catch((error: Error) =>
    render(`Could not create: ${error.message}`)
  );
});
// Closing with unsaved edits asks first.
window.addEventListener("beforeunload", (event) => {
  if (draft && dirty(draft)) {
    event.preventDefault();
  }
});

if (binding) {
  open().catch((error: Error) => {
    render(`This file could not be opened (${error.message})`);
    document.body.dataset.ready = "true";
  });
} else {
  render("No file open");
  document.body.dataset.ready = "true";
}
