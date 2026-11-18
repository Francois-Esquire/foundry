import type { Workbooks } from "../composition";
import {
  answered,
  type Draft,
  dirty,
  edit,
  keepMine,
  observed,
  opened,
  sameBase,
  takeTheirs,
} from "../draft";
import type { CellReference } from "../workbook/address";
import type { CellValue } from "../workbook/value";
import type { Workbook } from "../workbook/workbook";
import type { OpenWorkbook, WorkbookHost } from "./host";

export type WorkbookEdit =
  | {
      readonly kind: "enter";
      readonly sheet: string;
      readonly cell: string;
      readonly contents: string;
    }
  | { readonly kind: "add-sheet" }
  | {
      readonly kind: "rename-sheet";
      readonly sheet: string;
      readonly to: string;
    }
  | { readonly kind: "remove-sheet"; readonly sheet: string };

export interface WorkbookView {
  contents(reference: CellReference): string;
  readonly sheets: readonly string[];
  value(reference: CellReference): CellValue;
}

export interface EditorSnapshot {
  readonly binding: string | null;
  readonly conflict: boolean;
  readonly creating: boolean;
  readonly dirty: boolean;
  readonly message: string;
  readonly name: string;
  readonly newer: boolean;
  readonly ready: boolean;
  readonly saving: boolean;
  readonly workbook?: WorkbookView;
  readonly writable: boolean;
}

export class EditorSession {
  readonly #host: WorkbookHost;
  readonly #workbooks: Workbooks;
  readonly #listeners = new Set<() => void>();
  readonly #abort = new AbortController();
  #binding: string | null;
  #draft?: Draft;
  #workbook?: Workbook;
  #view?: WorkbookView;
  #started: boolean;
  #opening: Promise<void> | null = null;
  #following = false as boolean;
  #generation = 0;
  #state: EditorSnapshot;

  constructor(
    host: WorkbookHost,
    workbooks: Workbooks,
    binding: string | null
  ) {
    this.#host = host;
    this.#workbooks = workbooks;
    this.#binding = binding;
    this.#started = false;
    this.#state = {
      binding,
      conflict: false,
      creating: false,
      dirty: false,
      message: "",
      name: "Sheets",
      newer: false,
      ready: false,
      saving: false,
      writable: false,
    };
  }

  readonly getSnapshot = (): EditorSnapshot => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    if (!this.#binding) {
      this.#publish({ message: "No workbook open", ready: true });
      return;
    }
    await this.#serialized(this.#open(this.#binding));
  }

  apply(change: WorkbookEdit): boolean {
    const workbook = this.#workbook;
    const draft = this.#draft;
    if (!(workbook && draft && this.#state.writable)) {
      return false;
    }
    try {
      if (unchanged(workbook, change)) {
        return false;
      }
      applyEdit(workbook, change);
    } catch (error) {
      this.#failure(error);
      return false;
    }
    this.#generation += 1;
    this.#draft = edit(draft, workbook.toFile());
    this.#view = viewOf(workbook);
    this.#publish({ message: "Unsaved edits" });
    return true;
  }

  async save(): Promise<void> {
    const binding = this.#binding;
    const draft = this.#draft;
    if (
      !(binding && draft && dirty(draft)) ||
      this.#state.saving ||
      !this.#state.writable
    ) {
      return;
    }
    const { text: sent, base } = draft;
    this.#generation += 1;
    this.#publish({ message: "Saving…", saving: true });
    try {
      const answer = await this.#host.save(
        binding,
        base.digest,
        sent,
        this.#abort.signal
      );
      if (this.#abort.signal.aborted || !this.#draft) {
        return;
      }
      this.#draft = answered(this.#draft, sent, answer);
      this.#generation += 1;
      this.#publish({
        message:
          answer.kind === "saved" ? "Saved" : `Not saved: ${answer.kind}`,
        saving: false,
      });
    } catch (error) {
      this.#publish({ saving: false });
      this.#failure(error);
      return;
    }
    await this.#reloadIfClean();
  }

  create(): Promise<void> {
    if (this.#opening) {
      return this.#opening;
    }
    if (this.#binding) {
      return Promise.resolve();
    }
    this.#started = true;
    return this.#serialized(this.#createAndOpen());
  }

  async loadNewer(): Promise<void> {
    await this.#reload(true);
  }

  keepLocal(): void {
    if (!this.#draft?.conflict || this.#state.saving) {
      return;
    }
    this.#draft = keepMine(this.#draft);
    this.#generation += 1;
    this.#publish({
      message: "Keeping your version: save to replace the other one",
    });
  }

  takeSaved(): void {
    if (!this.#draft?.conflict || this.#state.saving) {
      return;
    }
    const next = takeTheirs(this.#draft);
    try {
      this.#install(next.text);
    } catch (error) {
      this.#failure(error);
      return;
    }
    const text = this.#workbook?.toFile() ?? next.text;
    this.#draft = { ...next, saved: text, text };
    this.#publish({ message: "Showing the saved version" });
    this.#reloadIfClean().catch((error: unknown) => this.#failure(error));
  }

  close(): void {
    this.#abort.abort();
    this.#workbook?.close();
    this.#listeners.clear();
  }

  #serialized(opening: Promise<void>): Promise<void> {
    const current = opening.finally(() => {
      if (this.#opening === current) {
        this.#opening = null;
      }
    });
    this.#opening = current;
    return current;
  }

  async #createAndOpen(): Promise<void> {
    const blank = this.#workbooks.create();
    const text = blank.toFile();
    blank.close();
    this.#publish({ creating: true, message: "Creating a workbook…" });
    try {
      const binding = await this.#host.create(text, this.#abort.signal);
      if (this.#abort.signal.aborted) {
        return;
      }
      this.#binding = binding;
      this.#publish({ creating: false });
      await this.#open(binding);
    } catch (error) {
      this.#publish({ creating: false });
      this.#failure(error);
    }
  }

  async #open(binding: string): Promise<void> {
    let document: OpenWorkbook;
    try {
      document = await this.#host.read(binding, this.#abort.signal);
      if (this.#abort.signal.aborted || binding !== this.#binding) {
        return;
      }
      this.#install(document.text);
    } catch (error) {
      this.#failure(error);
      return;
    }
    this.#loaded(document, document.writable ? "Saved" : "Read only");
    if (!this.#following) {
      this.#following = true;
      this.#follow(binding).catch((error: unknown) => this.#failure(error));
    }
  }

  async #follow(binding: string): Promise<void> {
    const after = this.#draft?.base;
    if (!after) {
      return;
    }
    let disconnected = false;
    for await (const event of this.#host.watch(
      binding,
      after,
      this.#abort.signal
    )) {
      if (this.#abort.signal.aborted || !this.#draft) {
        return;
      }
      if (event.kind === "unavailable") {
        disconnected = true;
        this.#publish({ message: event.message });
        continue;
      }
      if (disconnected) {
        this.#publish({ message: "Live updates restored" });
        disconnected = false;
      }
      const next = observed(this.#draft, event);
      this.#draft = next.draft;
      if (next.removed) {
        this.#publish({
          message: "This workbook was removed. Your edits are still here.",
          writable: false,
        });
        return;
      }
      this.#publish({});
      if (next.reload) {
        await this.#reload(false);
      }
    }
  }

  async #reloadIfClean(): Promise<void> {
    const draft = this.#draft;
    if (draft?.newer && !dirty(draft)) {
      await this.#reload(false);
    }
  }

  async #reload(discard: boolean): Promise<void> {
    const binding = this.#binding;
    if (!(binding && this.#draft) || this.#state.saving) {
      return;
    }
    const started = this.#generation;
    const reported = this.#draft.newer;
    let document: OpenWorkbook;
    try {
      document = await this.#host.read(binding, this.#abort.signal);
    } catch (error) {
      this.#failure(error);
      return;
    }
    const draft = this.#draft;
    if (this.#abort.signal.aborted || !draft) {
      return;
    }
    if (sameBase(document.base, draft.base)) {
      this.#draft =
        draft.newer === reported ? { ...draft, newer: null } : draft;
      this.#publish({});
      return;
    }
    const raced = started !== this.#generation || this.#state.saving;
    if (raced || (!discard && dirty(draft))) {
      this.#draft = { ...draft, newer: document.base };
      this.#publish({
        message: "A newer version is available. Your edits are kept.",
      });
      return;
    }
    try {
      this.#install(document.text);
    } catch (error) {
      this.#failure(error);
      return;
    }
    this.#loaded(document, "Updated from a newer save");
  }

  #install(text: string): void {
    const next = this.#workbooks.open(text);
    this.#workbook?.close();
    this.#workbook = next;
    this.#view = viewOf(next);
    this.#generation += 1;
  }

  #loaded(document: OpenWorkbook, message: string): void {
    this.#draft = opened(
      document.base,
      this.#workbook?.toFile() ?? document.text
    );
    this.#publish({
      message,
      name: document.name,
      ready: true,
      writable: document.writable,
    });
  }

  #publish(change: Partial<EditorSnapshot>): void {
    if (this.#abort.signal.aborted) {
      return;
    }
    const draft = this.#draft;
    this.#state = {
      ...this.#state,
      ...change,
      binding: this.#binding,
      conflict: Boolean(draft?.conflict),
      dirty: draft ? dirty(draft) : false,
      newer: Boolean(draft?.newer),
      workbook: this.#view,
    };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #failure(error: unknown): void {
    this.#publish({
      message: error instanceof Error ? error.message : "The operation failed",
      ready: true,
    });
  }
}

function viewOf(workbook: Workbook): WorkbookView {
  return {
    contents: (reference) => workbook.contents(reference),
    sheets: workbook.sheets,
    value: (reference) => workbook.value(reference),
  };
}

function unchanged(workbook: Workbook, change: WorkbookEdit): boolean {
  if (change.kind === "enter") {
    return workbook.contents(change) === change.contents;
  }
  return change.kind === "rename-sheet" && change.sheet === change.to;
}

function applyEdit(workbook: Workbook, change: WorkbookEdit): void {
  switch (change.kind) {
    case "enter":
      workbook.enter(change, change.contents);
      return;
    case "add-sheet":
      workbook.addSheet();
      return;
    case "rename-sheet":
      workbook.renameSheet(change.sheet, change.to);
      return;
    case "remove-sheet":
      workbook.removeSheet(change.sheet);
      return;
    default:
      unexpected(change);
  }
}

function unexpected(change: never): never {
  throw new Error(`Unknown workbook edit: ${JSON.stringify(change)}`);
}
