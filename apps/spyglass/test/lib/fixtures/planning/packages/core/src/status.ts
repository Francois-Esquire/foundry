export interface Status {
  ok: boolean;
}

function tag(ok: boolean): string {
  return ok ? "ok" : "fail";
}

export function formatStatus(s: Status): string {
  return tag(s.ok);
}
