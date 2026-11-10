import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fetchSamplePhotograph,
  listSamplePhotographs,
  SamplesUnavailableError,
} from "~/reconstruct/samples";
import { evidenceFile, fixtureFetch, STOREFRONT } from "./helpers/session";

const COMMONS = /^https:\/\/commons\.wikimedia\.org\//;

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("sample photographs", () => {
  it("lists each photograph with its licence and where it was published", async () => {
    const samples = await listSamplePhotographs(fixtureFetch, "/");
    expect(samples.map((sample) => sample.file)).toEqual([
      STOREFRONT,
      "ozark-copper-letters.jpg",
      "handwriting-defg.jpg",
    ]);
    for (const sample of samples) {
      expect(sample.licence).not.toBe("");
      expect(sample.source).toMatch(COMMONS);
    }
  });

  it("fetches a photograph byte for byte", async () => {
    const [storefront] = await listSamplePhotographs(fixtureFetch, "/");
    if (!storefront) {
      throw new Error("No sample was listed.");
    }
    const fetched = await fetchSamplePhotograph(fixtureFetch, "/", storefront);
    expect(fetched.fileName).toBe(STOREFRONT);
    expect(sha256(fetched.bytes)).toBe(sha256(evidenceFile(STOREFRONT).bytes));
  });

  it("says the samples are unavailable when the list cannot be read", async () => {
    await expect(
      listSamplePhotographs(() => Promise.reject(new Error("offline")), "/")
    ).rejects.toBeInstanceOf(SamplesUnavailableError);
    await expect(
      listSamplePhotographs(
        () => Promise.resolve(Response.json([{ file: "a.jpg" }])),
        "/"
      )
    ).rejects.toThrow("The list of sample photographs is not readable.");
  });
});
