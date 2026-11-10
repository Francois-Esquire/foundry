/**
 * Font files assembled in memory from the valid fixtures, so the repository
 * holds no opaque broken blobs. None of these belongs to the font collection.
 */

const DIRECTORY_START = 12;
const RECORD_SIZE = 16;
const TABLE_COUNT_AT = 4;
const TABLE_OFFSET_AT = 8;
const COLLECTION_TAG = 0x74_74_63_66;
const COLLECTION_VERSION = 0x00_01_00_00;

const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const alignToFour = (length: number) => Math.ceil(length / 4) * 4;

export const emptyFile = () => new Uint8Array();

/** Plain text, as when a file was renamed to .ttf. */
export const textFile = () =>
  new TextEncoder().encode("Specimen notes, saved with a font extension.\n");

/** The first half of a font, as after an interrupted download. */
export const cutShort = (font: Uint8Array) =>
  font.slice(0, Math.floor(font.byteLength / 2));

/**
 * A complete font whose table directory lost every table tag. The file has
 * the right size and signature, but no table can be found by name.
 */
export const withCorruptedDirectory = (font: Uint8Array) => {
  const corrupted = font.slice();
  const view = viewOf(corrupted);
  const tableCount = view.getUint16(TABLE_COUNT_AT);
  for (let table = 0; table < tableCount; table += 1) {
    view.setUint32(DIRECTORY_START + table * RECORD_SIZE, 0);
  }
  return corrupted;
};

/**
 * A font collection holding each given single-font file as one member. Table
 * offsets are rewritten to count from the start of the collection.
 */
export const collectionOf = (members: readonly Uint8Array[]) => {
  const headerSize = alignToFour(DIRECTORY_START + members.length * 4);
  const starts: number[] = [];
  let end = headerSize;
  for (const member of members) {
    starts.push(end);
    end += alignToFour(member.byteLength);
  }
  const collection = new Uint8Array(end);
  const view = viewOf(collection);
  view.setUint32(0, COLLECTION_TAG);
  view.setUint32(4, COLLECTION_VERSION);
  view.setUint32(8, members.length);
  for (const [index, member] of members.entries()) {
    const start = starts[index] ?? 0;
    view.setUint32(DIRECTORY_START + index * 4, start);
    collection.set(member, start);
    const tableCount = view.getUint16(start + TABLE_COUNT_AT);
    for (let table = 0; table < tableCount; table += 1) {
      const at =
        start + DIRECTORY_START + table * RECORD_SIZE + TABLE_OFFSET_AT;
      view.setUint32(at, view.getUint32(at) + start);
    }
  }
  return collection;
};
