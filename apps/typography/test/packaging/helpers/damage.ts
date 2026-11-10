/** Damaged fonts made in memory from valid fixtures. */

const DIRECTORY_START = 12;
const RECORD_SIZE = 16;
const HEADER_SIZE = 4;
const DAMAGE_SIZE = 60;

/**
 * A font that is sound except for one table: the bytes after that table's
 * version are overwritten, so its offsets point outside it. The file still
 * has the right signature, directory and size.
 */
export const withDamagedTable = (font: Uint8Array, tag: string) => {
  const damaged = font.slice();
  const view = new DataView(damaged.buffer);
  const tableCount = view.getUint16(4);
  for (let table = 0; table < tableCount; table += 1) {
    const record = DIRECTORY_START + table * RECORD_SIZE;
    const name = String.fromCodePoint(...damaged.subarray(record, record + 4));
    if (name === tag) {
      const start = view.getUint32(record + 8) + HEADER_SIZE;
      damaged.fill(0xff, start, start + DAMAGE_SIZE);
      return damaged;
    }
  }
  throw new Error(`The font has no ${tag} table to damage.`);
};
