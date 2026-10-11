import { welcome } from "@p/app";

export function page(name: string): string {
  return `<h1>${welcome(name)}</h1>`;
}
