/**
 * The picture files the app reads and sends: each media type with the
 * endings its file names carry, the usual one first.
 */
const ENDINGS: Readonly<Record<string, readonly string[]>> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/svg+xml": ["svg"],
  "image/webp": ["webp"],
};

/** What a file is called when nothing says what it is. */
export const UNKNOWN_MEDIA_TYPE = "application/octet-stream";

/** The media type a file name's ending suggests, for a file that arrives without one. */
export const pictureTypeFor = (fileName: string): string => {
  const ending = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  const found = Object.entries(ENDINGS).find(([, endings]) =>
    endings.includes(ending)
  );
  return found?.[0] ?? UNKNOWN_MEDIA_TYPE;
};

/** The ending a file of a media type is given. Undefined for a type that is not a picture's. */
export const endingFor = (mediaType: string): string | undefined =>
  ENDINGS[mediaType]?.[0];
