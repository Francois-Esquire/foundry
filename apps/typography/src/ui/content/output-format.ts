const KILOBYTE = 1024;

/** A byte size in kilobytes, with at most one decimal place. */
export const formatSize = (bytes: number) =>
  `${(bytes / KILOBYTE).toLocaleString("en", { maximumFractionDigits: 1 })} KB`;

/** The local time of an ISO timestamp, down to seconds. */
export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** A number written with English grouping separators. */
export const formatNumber = (value: number) => value.toLocaleString("en");
