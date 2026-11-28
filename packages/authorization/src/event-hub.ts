import type { AuthorizationEvent } from "./schema";

export interface EventHub {
  readonly observers: Set<(event: AuthorizationEvent) => void>;
  readonly permitHandlers: Set<(event: AuthorizationEvent) => void>;
}

export function createEventHub(): EventHub {
  return {
    observers: new Set(),
    permitHandlers: new Set(),
  };
}

export function dispatchEvent(hub: EventHub, event: AuthorizationEvent): void {
  dispatchAll(hub.permitHandlers, event);
  dispatchAll(hub.observers, event);
}

function dispatchAll(
  listeners: ReadonlySet<(event: AuthorizationEvent) => void>,
  event: AuthorizationEvent
): void {
  for (const listener of [...listeners]) {
    invokeSafely(listener, event);
  }
}

function invokeSafely(
  listener: (event: AuthorizationEvent) => void,
  event: AuthorizationEvent
): boolean {
  try {
    listener(event);
    return true;
  } catch {
    return false;
  }
}
