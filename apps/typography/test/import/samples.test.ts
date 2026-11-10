import { describe, expect, it } from "vitest";
import {
  type Fetch,
  fetchSamples,
  listSamples,
  SamplesUnavailableError,
} from "~/import/samples";

const respond = (body: string | Uint8Array | undefined) => ({
  arrayBuffer: async () =>
    (typeof body === "string"
      ? new TextEncoder().encode(body)
      : (body ?? new Uint8Array())
    ).slice().buffer,
  json: async () =>
    JSON.parse(typeof body === "string" ? body : "null") as unknown,
  ok: body !== undefined,
  text: async () => (typeof body === "string" ? body : ""),
});

/** A server holding the given files. Anything else answers "not found". */
const serving =
  (files: Readonly<Record<string, string | Uint8Array>>): Fetch =>
  async (address) =>
    respond(files[address]);

const INDEX = JSON.stringify([
  { file: "Lato Regular.ttf", licence: "Lato-OFL.txt" },
]);
const LICENCE =
  '\nCopyright (c) 2010 Someone with Reserved Font Name "Lato"\n\nThis Font Software is licensed under the SIL Open Font License.\n';

describe("listSamples", () => {
  it("lists each sample with the opening line of its licence and where to read it", async () => {
    const samples = await listSamples(
      serving({
        "/app/samples/index.json": INDEX,
        "/app/samples/Lato-OFL.txt": LICENCE,
      }),
      "/app/"
    );
    expect(samples).toEqual([
      {
        copyright: 'Copyright (c) 2010 Someone with Reserved Font Name "Lato"',
        file: "Lato Regular.ttf",
        licenceAddress: "/app/samples/Lato-OFL.txt",
      },
    ]);
  });

  it("fails when the list is missing, unreadable, or a licence is absent", async () => {
    await expect(listSamples(serving({}), "/")).rejects.toBeInstanceOf(
      SamplesUnavailableError
    );
    await expect(
      listSamples(serving({ "/samples/index.json": '{"fonts":[]}' }), "/")
    ).rejects.toBeInstanceOf(SamplesUnavailableError);
    await expect(
      listSamples(serving({ "/samples/index.json": INDEX }), "/")
    ).rejects.toBeInstanceOf(SamplesUnavailableError);
  });

  it("fails the same way when the network does", async () => {
    const offline: Fetch = () =>
      Promise.reject(new TypeError("Failed to fetch"));
    await expect(listSamples(offline, "/")).rejects.toBeInstanceOf(
      SamplesUnavailableError
    );
  });
});

describe("fetchSamples", () => {
  const sample = {
    copyright: "",
    file: "Lato Regular.ttf",
    licenceAddress: "",
  };

  it("fetches each file's bytes under its own name", async () => {
    const bytes = Uint8Array.of(0, 1, 0, 0, 7);
    const files = await fetchSamples(
      serving({ "/samples/Lato%20Regular.ttf": bytes }),
      "/",
      [sample]
    );
    expect(files).toEqual([{ bytes, name: "Lato Regular.ttf" }]);
  });

  it("fails when a file is unavailable, so a partial set is never imported", async () => {
    await expect(
      fetchSamples(serving({}), "/", [sample])
    ).rejects.toBeInstanceOf(SamplesUnavailableError);
  });
});
