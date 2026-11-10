/**
 * Reads a section out of the verification report. The report's "Not
 * verified" list is written in one place, in the report, and is shown as it
 * stands there instead of being worded a second time.
 */

const HEADING = /^#{1,6} /;
const ITEM = "- ";

/** The list items under a second-level heading of a Markdown report, in order. */
export const listUnder = (report: string, heading: string): string[] => {
  const lines = report.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) {
    return [];
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => HEADING.test(line));
  return (end === -1 ? rest : rest.slice(0, end))
    .filter((line) => line.startsWith(ITEM))
    .map((line) => line.slice(ITEM.length));
};

export const NOT_VERIFIED_HEADING = "Not verified";
