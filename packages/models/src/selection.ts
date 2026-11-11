/**
 * What a caller names: a model, or a provider and a model. A string holding
 * `/` is read both as `provider/model` and as a bare model id.
 */
export type ModelSelection =
  | string
  | { readonly provider?: string; readonly model?: string };

/** A checked provider and catalog id, as a host stores it. */
export interface Route {
  readonly model: string;
  readonly provider: string;
}

/** The selection string that names exactly this route. */
export function formatSelection(route: Route): string {
  return `${route.provider}/${route.model}`;
}
