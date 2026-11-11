/** A face is one style of a family, read from one source font. */

export type SourceId = string;
export type FaceId = string;

export interface VariationAxis {
  readonly default: number;
  readonly max: number;
  readonly min: number;
  readonly name: string;
  readonly tag: string;
}

/** Axis tag to value, for example { wght: 700 }. Missing axes sit at their default. */
export type AxisLocation = Readonly<Record<string, number>>;

export interface NamedInstance {
  readonly location: AxisLocation;
  readonly name: string;
}

export interface FaceMetrics {
  readonly ascender: number;
  readonly capHeight?: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly unitsPerEm: number;
  readonly xHeight?: number;
}

export type OutlineFormat = "truetype" | "cff" | "cff2" | "none";

/** What the font says about its own licence. Checked before a derived export. */
export interface LicenceNotice {
  readonly copyright?: string;
  readonly description?: string;
  /** OS/2 fsType embedding bits. 0 means installable embedding. */
  readonly embedding: number;
  readonly url?: string;
}

export interface LayoutFeatures {
  readonly positioning: readonly string[];
  /** OpenType script tags the layout tables name, for example latn or dev2. */
  readonly scripts: readonly string[];
  readonly substitution: readonly string[];
}

export interface FaceDescription {
  readonly axes: readonly VariationAxis[];
  readonly characterCount: number;
  readonly designer?: string;
  readonly familyName: string;
  readonly fullName: string;
  readonly glyphCount: number;
  readonly instances: readonly NamedInstance[];
  readonly italic: boolean;
  readonly layout: LayoutFeatures;
  readonly licence: LicenceNotice;
  readonly metrics: FaceMetrics;
  readonly outlineFormat: OutlineFormat;
  readonly postScriptName: string;
  readonly styleName: string;
  readonly version?: string;
  readonly weightClass: number;
  readonly widthClass: number;
}

export interface Face {
  readonly description: FaceDescription;
  readonly id: FaceId;
  /** Position inside a font collection. 0 for a single-font file. */
  readonly index: number;
  /**
   * Set when this face is one pinned instance of a variable source. Only
   * static faces and pinned instances can be edited.
   */
  readonly pinned?: {
    readonly location: AxisLocation;
    readonly styleName: string;
  };
  readonly sourceId: SourceId;
}

export const isVariable = (face: Face) =>
  face.description.axes.length > 0 && !face.pinned;

export const isEditable = (face: Face) => !isVariable(face);

export const faceStyleName = (face: Face) =>
  face.pinned?.styleName ?? face.description.styleName;

export const defaultLocation = (axes: readonly VariationAxis[]): AxisLocation =>
  Object.fromEntries(axes.map((axis) => [axis.tag, axis.default]));

export const clampLocation = (
  axes: readonly VariationAxis[],
  location: AxisLocation
): AxisLocation =>
  Object.fromEntries(
    axes.map((axis) => [
      axis.tag,
      Math.min(
        axis.max,
        Math.max(axis.min, location[axis.tag] ?? axis.default)
      ),
    ])
  );

/** "wdth 80, wght 700": a location in words, in the order of the axis tags. */
export const locationLabel = (location: AxisLocation): string =>
  Object.keys(location)
    .sort()
    .map((tag) => `${tag} ${location[tag]}`)
    .join(", ");

/** "Lato Regular": a face's family and style, as a person would say it. */
export const faceName = (face: Face): string =>
  `${face.description.familyName} ${faceStyleName(face)}`;

/**
 * What a face is called in a list of faces: its family and style, and for a
 * pinned instance where it is pinned. A pinned instance can carry the style
 * name of its variable face, and the two must never read as one face.
 */
export const faceListLabel = (face: Face): string => {
  const { familyName } = face.description;
  if (!face.pinned) {
    return faceName(face);
  }
  const { location, styleName } = face.pinned;
  const at = locationLabel(location);
  // An instance the font does not name is called by its location already,
  // written as "wght 550" or "wght550". Saying it twice helps nobody.
  const values = Object.keys(location).map((tag) => `${tag}${location[tag]}`);
  const compact = styleName.replaceAll(/[\s,]+/g, "");
  const namedByLocation =
    compact.length === values.join("").length &&
    values.every((value) => compact.includes(value));
  return namedByLocation
    ? `${familyName}, pinned at ${at}`
    : `${familyName} ${styleName}, pinned at ${at}`;
};

/** A stable text key for a location, with the axes in alphabetical order. */
export const locationKey = (location: AxisLocation): string =>
  Object.keys(location)
    .sort()
    .map((tag) => `${tag}=${location[tag]}`)
    .join(",");

/**
 * The named instance that sits exactly at a location, if the font names one.
 * An axis either of them leaves out sits at its default.
 */
export const instanceAt = (
  { axes, instances }: Pick<FaceDescription, "axes" | "instances">,
  location: AxisLocation
): NamedInstance | undefined => {
  const key = locationKey(clampLocation(axes, location));
  return instances.find(
    (instance) => locationKey(clampLocation(axes, instance.location)) === key
  );
};
