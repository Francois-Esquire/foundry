const metricLabelPattern = /([a-z])([A-Z])/g;
export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function plural(itemCount: number, noun: string): string {
  return `${itemCount} ${noun}${itemCount === 1 ? "" : "s"}`;
}

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

export function ago(days: number | undefined): string {
  if (days === undefined) {
    return "never committed";
  }
  if (days === 0) {
    return "today";
  }
  return `${plural(days, "day")} ago`;
}

export function windowLabel(windowDays: number | null): string {
  return windowDays === null ? "full history" : `last ${windowDays} days`;
}

/** `primaryConsumerShare` → `primary consumer share`. */
function metricLabel(metric: string): string {
  return metric.replace(metricLabelPattern, "$1 $2").toLowerCase();
}

const SHARE_METRIC =
  /(Share|Reach|Concentration|Ratio|Rate|Utilization|Coverage)$/;

/** Analysis emits shares as 0..1 under a few name suffixes; show those as percent. */
export function metricValue(
  metric: string,
  value: number | string | boolean
): string {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (typeof value === "string") {
    return value;
  }
  if (SHARE_METRIC.test(metric)) {
    return percent(value);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function evidenceLine(
  metric: string,
  value: number | string | boolean
): string {
  return `${metricLabel(metric)} ${metricValue(metric, value)}`;
}
