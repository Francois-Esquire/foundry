/**
 * The sample photographs the app serves for someone with no picture of
 * lettering to hand. Each is listed with its licence and where it came from.
 */

export interface SamplePhotograph {
  readonly description: string;
  readonly file: string;
  readonly licence: string;
  /** Where the photograph was published. */
  readonly source: string;
  readonly title: string;
}

/** Fetches one address. The browser's fetch in the app, a file reader in tests. */
export type Fetch = (address: string) => Promise<Response>;

export class SamplesUnavailableError extends Error {
  override readonly name = "SamplesUnavailableError";
}

const ROUTE = "evidence";

const FIELDS = ["description", "file", "licence", "source", "title"] as const;

const isSample = (value: unknown): value is SamplePhotograph =>
  typeof value === "object" &&
  value !== null &&
  FIELDS.every(
    (field) =>
      field in value &&
      typeof (value as Readonly<Record<string, unknown>>)[field] === "string"
  );

const get = async (fetcher: Fetch, address: string): Promise<Response> => {
  const response = await fetcher(address).catch(() => undefined);
  if (!response?.ok) {
    throw new SamplesUnavailableError(`${address} could not be loaded.`);
  }
  return response;
};

/** The sample photographs on offer. `base` ends in a slash. */
export const listSamplePhotographs = async (
  fetcher: Fetch,
  base: string
): Promise<SamplePhotograph[]> => {
  const index: unknown = await (
    await get(fetcher, `${base}${ROUTE}/index.json`)
  ).json();
  if (!(Array.isArray(index) && index.every(isSample))) {
    throw new SamplesUnavailableError(
      "The list of sample photographs is not readable."
    );
  }
  return index;
};

/** Fetches one sample photograph's file, byte for byte. */
export const fetchSamplePhotograph = async (
  fetcher: Fetch,
  base: string,
  sample: SamplePhotograph
): Promise<{ readonly bytes: Uint8Array; readonly fileName: string }> => {
  const response = await get(
    fetcher,
    `${base}${ROUTE}/${encodeURIComponent(sample.file)}`
  );
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    fileName: sample.file,
  };
};
