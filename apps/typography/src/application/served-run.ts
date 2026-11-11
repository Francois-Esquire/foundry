/**
 * Serves one recorded run from memory, the way the app's server serves its
 * recorded runs. A place's session lists and loads recorded runs by address,
 * so this is how a command hands it the run it was given.
 */
import type { Fetch } from "~/generate/recorded-catalogue";

/** Where a place's session fetches its recorded runs from. */
export interface RecordedRuns {
  /** Where the runs are served from, ending in a slash. */
  readonly base: string;
  readonly fetch: Fetch;
}

const ROUTE = "/recorded-runs/";
const SEPARATOR = /[\\/]+/;

/** The last part of a location: the name a recorded run's directory goes by. */
export const runName = (location: string) =>
  location.split(SEPARATOR).filter(Boolean).at(-1) ?? location;
const NOT_FOUND = 404;

const found = (bytes: Uint8Array) =>
  new Response(bytes as Uint8Array<ArrayBuffer>);

/** `directory` is the name the run is listed under. */
export const servedRun = (
  directory: string,
  files: ReadonlyMap<string, Uint8Array>
): RecordedRuns => ({
  base: "/",
  fetch(address) {
    if (address === `${ROUTE}index.json`) {
      return Promise.resolve(Response.json([directory]));
    }
    const prefix = `${ROUTE}${directory}/`;
    const file = address.startsWith(prefix)
      ? files.get(decodeURIComponent(address.slice(prefix.length)))
      : undefined;
    return Promise.resolve(
      file ? found(file) : new Response(null, { status: NOT_FOUND })
    );
  },
});

/** For a session that replays nothing: every address is missing. */
export const NO_RECORDED_RUNS: RecordedRuns = {
  base: "/",
  fetch: () => Promise.resolve(new Response(null, { status: NOT_FOUND })),
};
