export const HTML_MIME = "text/html";
export const UNKNOWN_MIME = "application/octet-stream";

const TEXT_MIME =
  /^(text\/|application\/(json|javascript|xml|.*\+(json|xml)$))/;

export function isTextMime(mime: string | null): boolean {
  return mime !== null && TEXT_MIME.test(mime);
}
