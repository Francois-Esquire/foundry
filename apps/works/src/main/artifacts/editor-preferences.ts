import { readJsonFile, writeFileAtomic } from "@foundry/lib/atomic-file";
import { z } from "zod";
import type { EditorPreference } from "./resolver";

const RECORD_FORMAT = "works.editor-preferences/1";

const recordSchema = z.object({
  format: z.literal(RECORD_FORMAT),
  preferences: z.record(
    z.string(),
    z.object({ moduleId: z.string(), view: z.string() })
  ),
});

type Preferences = Readonly<Record<string, EditorPreference>>;

/**
 * The `editor.preference` setting: which editor the user chose when several
 * matched one MIME type. Host-owned Works state, apart from Module settings
 * (those are numeric, per Module and saved whole) because one choice is
 * made between Modules. A choice naming a Module or View that no longer
 * matches is ignored, so the user is asked again; so is every choice in a
 * file this version cannot read, which the next choice replaces.
 */
export class EditorPreferences {
  readonly #file: string | null;
  #record: Promise<Preferences> | undefined;
  #writes: Promise<void> = Promise.resolve();

  /** `file: null` keeps choices in memory only. */
  constructor(options: { readonly file: string | null }) {
    this.#file = options.file;
  }

  all(): Promise<Preferences> {
    this.#record ??= (
      this.#file ? readRecord(this.#file) : Promise.resolve({})
    ).catch((error: unknown) => {
      this.#record = undefined;
      throw error;
    });
    return this.#record;
  }

  /** One write at a time; a failed one does not stop the next. */
  remember(mime: string, preference: EditorPreference): Promise<void> {
    const write = this.#writes.then(async () => {
      const next = {
        ...(await this.all()),
        [mime]: { moduleId: preference.moduleId, view: preference.view },
      };
      if (this.#file) {
        await writeRecord(this.#file, next);
      }
      this.#record = Promise.resolve(next);
    });
    this.#writes = write.catch(() => undefined);
    return write;
  }
}

/** The choices in a record this version wrote; {} for a missing file. */
async function readRecord(file: string): Promise<Preferences> {
  let value: unknown;
  try {
    value = await readJsonFile(file);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return unreadable(file);
  }
  if (value === undefined) {
    return {};
  }
  const record = recordSchema.safeParse(value);
  return record.success ? record.data.preferences : unreadable(file);
}

function unreadable(file: string): Preferences {
  process.stderr.write(
    `Editor choices in ${file} are unreadable; Works will ask again.\n`
  );
  return {};
}

function writeRecord(file: string, preferences: Preferences): Promise<void> {
  return writeFileAtomic(
    file,
    JSON.stringify({ format: RECORD_FORMAT, preferences }),
    { directoryMode: 0o700, mode: 0o600 }
  );
}
