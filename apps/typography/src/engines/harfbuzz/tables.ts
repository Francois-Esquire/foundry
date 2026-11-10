/**
 * Reads the few fixed-layout font table fields HarfBuzz does not expose.
 * Offsets follow the OpenType specification.
 */
import type { AxisLocation, NamedInstance } from "~/typeface/face";

export type TableSource = (tag: string) => DataView | undefined;

export const TTC_TAG = 0x74_74_63_66;

const SFNT_VERSIONS = new Set([
  0x00_01_00_00, 0x4f_54_54_4f, 0x74_72_75_65, 0x74_79_70_31,
]);

/** Faces in the file, or 0 when the bytes are not a TrueType or OpenType font. */
export const countFaces = (bytes: Uint8Array): number => {
  if (bytes.byteLength < 12) {
    return 0;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint32(0);
  if (tag === TTC_TAG) {
    return view.getUint32(8);
  }
  return SFNT_VERSIONS.has(tag) ? 1 : 0;
};

const tablesEndInside = (view: DataView, offset: number): boolean => {
  if (offset + 12 > view.byteLength) {
    return false;
  }
  const tableCount = view.getUint16(offset + 4);
  const directoryEnd = offset + 12 + tableCount * 16;
  if (directoryEnd > view.byteLength) {
    return false;
  }
  for (let record = offset + 12; record < directoryEnd; record += 16) {
    if (
      view.getUint32(record + 8) + view.getUint32(record + 12) >
      view.byteLength
    ) {
      return false;
    }
  }
  return true;
};

/** True when a table the file lists runs past the end of the file. */
export const isCutShort = (bytes: Uint8Array): boolean => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== TTC_TAG) {
    return !tablesEndInside(view, 0);
  }
  const faces = view.getUint32(8);
  if (12 + faces * 4 > view.byteLength) {
    return true;
  }
  return Array.from({ length: faces }, (_, face) =>
    view.getUint32(12 + face * 4)
  ).some((offset) => !tablesEndInside(view, offset));
};

export interface Os2Fields {
  readonly ascender: number;
  readonly capHeight?: number;
  readonly descender: number;
  readonly embedding: number;
  readonly italic: boolean;
  readonly lineGap: number;
  readonly weightClass: number;
  readonly widthClass: number;
  readonly xHeight?: number;
}

export const readOs2 = (table: DataView | undefined): Os2Fields | undefined => {
  if (!table || table.byteLength < 78) {
    return;
  }
  const hasHeights = table.getUint16(0) >= 2 && table.byteLength >= 90;
  return {
    ascender: table.getInt16(68),
    capHeight: hasHeights ? table.getInt16(88) : undefined,
    descender: table.getInt16(70),
    embedding: table.getUint16(8),
    italic: table.getUint16(62) % 2 === 1,
    lineGap: table.getInt16(72),
    weightClass: table.getUint16(4),
    widthClass: table.getUint16(6),
    xHeight: hasHeights ? table.getInt16(86) : undefined,
  };
};

export const readHhea = (table: DataView | undefined) =>
  table && table.byteLength >= 10
    ? {
        ascender: table.getInt16(4),
        descender: table.getInt16(6),
        lineGap: table.getInt16(8),
      }
    : undefined;

export const readGlyphCount = (table: DataView | undefined) =>
  table && table.byteLength >= 6 ? table.getUint16(4) : 0;

/** macStyle bit 1 marks an italic face. */
export const readMacItalic = (table: DataView | undefined) =>
  table !== undefined &&
  table.byteLength >= 46 &&
  Math.floor(table.getUint16(44) / 2) % 2 === 1;

const fixed = (table: DataView, offset: number) =>
  table.getInt32(offset) / 65_536;

const AXIS_RECORD_SIZE = 20;

/**
 * Named instances from fvar, with the name resolved by the caller. Counts the
 * table cannot hold are cut to what fits, so a damaged table loses instances
 * and the font still opens.
 */
export const readInstances = (
  table: DataView | undefined,
  nameOf: (nameId: number) => string
): NamedInstance[] => {
  if (!table || table.byteLength < 16) {
    return [];
  }
  const axesOffset = table.getUint16(4);
  const axisSize = table.getUint16(10);
  const instanceSize = table.getUint16(14);
  if (axisSize < AXIS_RECORD_SIZE) {
    return [];
  }
  const axisCount = Math.min(
    table.getUint16(8),
    Math.max(0, Math.floor((table.byteLength - axesOffset) / axisSize))
  );
  const instancesOffset = axesOffset + axisCount * axisSize;
  if (instanceSize < 4 + axisCount * 4) {
    return [];
  }
  const instanceCount = Math.min(
    table.getUint16(12),
    Math.max(0, Math.floor((table.byteLength - instancesOffset) / instanceSize))
  );
  const tags = Array.from({ length: axisCount }, (_, axis) => {
    const offset = axesOffset + axis * axisSize;
    return String.fromCharCode(
      table.getUint8(offset),
      table.getUint8(offset + 1),
      table.getUint8(offset + 2),
      table.getUint8(offset + 3)
    );
  });
  return Array.from({ length: instanceCount }, (_, instance) => {
    const offset = instancesOffset + instance * instanceSize;
    const location: AxisLocation = Object.fromEntries(
      tags.map((tag, axis) => [tag, fixed(table, offset + 4 + axis * 4)])
    );
    return { location, name: nameOf(table.getUint16(offset)) };
  });
};
