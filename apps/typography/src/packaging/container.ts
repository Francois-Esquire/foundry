/** Font file containers. A font reader opens plain font files only. */
import type { FontBuilder } from "./building";

const WOFF2_SIGNATURE = [0x77, 0x4f, 0x46, 0x32];

export const isWoff2 = (font: Uint8Array) =>
  WOFF2_SIGNATURE.every((byte, index) => font[index] === byte);

/**
 * The plain font inside a WOFF2 file. The engine does the unpacking: a build
 * with no changes that asks for an uncompressed file.
 */
export const unpackWoff2 = async (
  builder: FontBuilder,
  font: Uint8Array
): Promise<Uint8Array> => {
  const unpacked = await builder.build({
    added: [],
    faceIndex: 0,
    featureCode: [],
    flavor: "ttf",
    overrides: new Map(),
    source: font,
  });
  return unpacked.bytes;
};
