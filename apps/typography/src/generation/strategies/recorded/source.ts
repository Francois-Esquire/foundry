/**
 * Where recorded runs are read from. A run is a set of files under one
 * name: `run.json` and the files it names. A source says which runs it holds
 * and hands over one file at a time, so a replay never learns whether the
 * files came over the network or were already in memory.
 */
import { RecordedRunError } from "./manifest";

export interface RecordedRunSource {
  /** One file of a run, byte for byte. Refuses when the file is not there. */
  file(run: string, name: string): Promise<Uint8Array>;
  /** The names of the runs the source holds. */
  list(): Promise<readonly string[]>;
}

const ROUTE = "recorded-runs";

/**
 * The recorded runs an app is served with: `recorded-runs/index.json` names
 * them and each has a directory of that name. `base` ends in a slash.
 */
export const fetchedRuns = (
  base: string,
  fetcher: (address: string) => Promise<Response>
): RecordedRunSource => {
  const fetchOk = async (address: string): Promise<Response> => {
    const response = await fetcher(address);
    if (!response.ok) {
      throw new RecordedRunError(
        `${address} could not be fetched (${response.status}).`
      );
    }
    return response;
  };
  return {
    file: async (run, name) =>
      new Uint8Array(
        await (await fetchOk(`${base}${ROUTE}/${run}/${name}`)).arrayBuffer()
      ),
    async list() {
      const index: unknown = await (
        await fetchOk(`${base}${ROUTE}/index.json`)
      ).json();
      return Array.isArray(index)
        ? index.filter((item): item is string => typeof item === "string")
        : [];
    },
  };
};

/** One recorded run with every file it has, in memory. */
export interface FilesRun extends RecordedRunSource {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly name: string;
}

/** A source that holds one run: the files given, under the name given. */
export const filesRun = (
  name: string,
  files: ReadonlyMap<string, Uint8Array>
): FilesRun => ({
  file(run, fileName) {
    const bytes = run === name ? files.get(fileName) : undefined;
    return bytes
      ? Promise.resolve(bytes)
      : Promise.reject(
          new RecordedRunError(
            `The recorded run ${run} has no file named ${fileName}.`
          )
        );
  },
  files,
  list: () => Promise.resolve([name]),
  name,
});
