export type ModelSelection =
  | string
  | { readonly provider?: string; readonly model?: string };

export interface Route {
  readonly model: string;
  readonly provider: string;
}

export function formatSelection(route: Route): string {
  return `${route.provider}/${route.model}`;
}
