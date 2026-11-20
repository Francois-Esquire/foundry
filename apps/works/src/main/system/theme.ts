import { readJsonFile, writeFileAtomic } from "@foundry/lib/atomic-file";
import { z } from "zod";
import { latest } from "~/main/platform/latest";
import {
  THEME_MODES,
  type ThemeAppearance,
  type ThemeMode,
  type ThemeSnapshot,
} from "~/shared/theme";

const RECORD_FORMAT = "works.theme/1";

const recordSchema = z.object({
  format: z.literal(RECORD_FORMAT),
  mode: z.enum(THEME_MODES),
});

export interface NativeTheme {
  readonly dark: boolean;
  onUpdated(listener: () => void): () => void;
  setSource(source: "system" | ThemeAppearance): void;
}

export class SystemTheme {
  readonly #listeners = new Set<(snapshot: ThemeSnapshot) => void>();
  readonly #opened = Promise.withResolvers<void>();
  #detach: (() => void) | undefined;
  #file: string | undefined;
  #mode: ThemeMode = "auto";
  #native: NativeTheme | undefined;
  #snapshot: ThemeSnapshot | undefined;
  #stored = false as boolean;
  #writes: Promise<void> = Promise.resolve();

  async open(input: {
    readonly file: string;
    readonly native: NativeTheme;
  }): Promise<ThemeSnapshot> {
    if (this.#native) {
      throw new Error("The system theme is already open");
    }
    const stored = await readPreference(input.file);
    this.#file = input.file;
    this.#native = input.native;
    this.#stored = stored !== undefined;
    this.#detach = input.native.onUpdated(() => this.#publish());
    const snapshot = this.#apply(stored ?? "auto");
    this.#opened.resolve();
    return snapshot;
  }

  snapshot(): ThemeSnapshot | undefined {
    return this.#snapshot;
  }

  async ready(): Promise<ThemeSnapshot> {
    await this.#opened.promise;
    return this.#required();
  }

  subscribe(listener: (snapshot: ThemeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  watch(signal?: AbortSignal): AsyncGenerator<ThemeSnapshot, void> {
    return latest({
      read: () => this.ready(),
      same: (previous, next) => next.revision <= previous.revision,
      signal,
      subscribe: (changed) => this.subscribe(changed),
    });
  }

  get subscribers(): number {
    return this.#listeners.size;
  }

  adopt(mode: ThemeMode | null): Promise<ThemeSnapshot> {
    return this.#stored ? this.ready() : this.set(mode ?? "auto");
  }

  set(mode: ThemeMode): Promise<ThemeSnapshot> {
    const snapshot = this.#apply(mode);
    this.#stored = true;
    const file = this.#file;
    if (file === undefined) {
      return Promise.resolve(snapshot);
    }
    const write = this.#writes.then(() => writePreference(file, mode));
    this.#writes = write.catch(() => undefined);
    return write.then(() => snapshot);
  }

  close(): void {
    this.#detach?.();
    this.#detach = undefined;
  }

  #apply(mode: ThemeMode): ThemeSnapshot {
    const native = this.#native;
    if (!native) {
      throw new Error("The system theme is not open");
    }
    this.#mode = mode;
    native.setSource(mode === "auto" ? "system" : mode);
    return this.#publish();
  }

  #publish(): ThemeSnapshot {
    const mode = this.#mode;
    let effective: ThemeAppearance = mode === "auto" ? "light" : mode;
    if (mode === "auto" && this.#native?.dark) {
      effective = "dark";
    }
    const previous = this.#snapshot;
    if (previous?.mode === mode && previous.effective === effective) {
      return previous;
    }
    const snapshot: ThemeSnapshot = Object.freeze({
      effective,
      mode,
      revision: (previous?.revision ?? 0) + 1,
    });
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) {
      listener(snapshot);
    }
    return snapshot;
  }

  #required(): ThemeSnapshot {
    if (!this.#snapshot) {
      throw new Error("The system theme is not open");
    }
    return this.#snapshot;
  }
}

export const systemTheme = new SystemTheme();

async function readPreference(file: string): Promise<ThemeMode | undefined> {
  let record: unknown;
  try {
    record = await readJsonFile(file);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return;
    }
    throw error;
  }
  return recordSchema.safeParse(record).data?.mode;
}

function writePreference(file: string, mode: ThemeMode): Promise<void> {
  return writeFileAtomic(
    file,
    JSON.stringify({ format: RECORD_FORMAT, mode }),
    {
      directoryMode: 0o700,
      mode: 0o600,
    }
  );
}
