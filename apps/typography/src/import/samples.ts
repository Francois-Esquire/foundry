/**
 * The sample fonts the app serves for someone with no font to hand. Each comes
 * with its licence text, and the first line of that text, the copyright
 * notice, is shown beside it.
 */
import type { ImportFile } from "~/workspace/importing";

export interface SampleFont {
  /** The licence's opening line, as its text states it. */
  readonly copyright: string;
  readonly file: string;
  /** Where the full licence text can be read. */
  readonly licenceAddress: string;
}

/** The part of `fetch` this module needs, so tests can pass a plain function. */
export type Fetch = (address: string) => Promise<{
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
  readonly ok: boolean;
  text(): Promise<string>;
}>;

export class SamplesUnavailableError extends Error {
  override readonly name = "SamplesUnavailableError";
}

interface IndexEntry {
  readonly file: string;
  readonly licence: string;
}

const isIndexEntry = (value: unknown): value is IndexEntry =>
  typeof value === "object" &&
  value !== null &&
  "file" in value &&
  typeof value.file === "string" &&
  "licence" in value &&
  typeof value.licence === "string";

const addressOf = (base: string, name: string) =>
  `${base}samples/${encodeURIComponent(name)}`;

const get = async (fetch: Fetch, address: string) => {
  const response = await fetch(address).catch(() => undefined);
  if (!response?.ok) {
    throw new SamplesUnavailableError(`${address} could not be loaded.`);
  }
  return response;
};

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/** The samples on offer, each with the opening line of its licence. `base` ends in a slash. */
export const listSamples = async (
  fetch: Fetch,
  base: string
): Promise<SampleFont[]> => {
  const index = await (await get(fetch, addressOf(base, "index.json"))).json();
  if (!(Array.isArray(index) && index.every(isIndexEntry))) {
    throw new SamplesUnavailableError("The list of samples is not readable.");
  }
  return Promise.all(
    index.map(async ({ file, licence }) => {
      const licenceAddress = addressOf(base, licence);
      return {
        copyright: firstLine(await (await get(fetch, licenceAddress)).text()),
        file,
        licenceAddress,
      };
    })
  );
};

/** Fetches the sample files, ready to import. Rejects when any of them is unavailable. */
export const fetchSamples = (
  fetch: Fetch,
  base: string,
  samples: readonly SampleFont[]
): Promise<ImportFile[]> =>
  Promise.all(
    samples.map(async ({ file }) => ({
      bytes: new Uint8Array(
        await (await get(fetch, addressOf(base, file))).arrayBuffer()
      ),
      name: file,
    }))
  );
