// Domain concept; store holds the persisted representation and converters.
export interface Domain {
  id: string;
  status: string;
  attempts: number;
  output: string;
}

export function observe(): Domain {
  return { id: "d", status: "ok", attempts: 1, output: "" };
}
