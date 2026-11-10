const KILOBYTE = 1024;

/** A file size for a list: 812 B, 64 kB, 1.2 MB. */
export const formatBytes = (bytes: number): string => {
  if (bytes < KILOBYTE) {
    return `${bytes} B`;
  }
  const kilobytes = bytes / KILOBYTE;
  return kilobytes < KILOBYTE
    ? `${Math.round(kilobytes)} kB`
    : `${(kilobytes / KILOBYTE).toFixed(1)} MB`;
};
