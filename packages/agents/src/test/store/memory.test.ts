import { SessionWindow } from "../../contexts/session-window";
import type { SessionStore } from "../../store";
import { InMemorySessionStore } from "../../store/memory";
import { describeSessionStore } from "../../testing/store";

// Memory has no shared medium, so each scope is its own store, and asking
// for a scope again returns that same store.
describeSessionStore("InMemorySessionStore", () => {
  const scopes = new Map<string, SessionStore>();
  return (scope) => {
    const store = scopes.get(scope) ?? new InMemorySessionStore();
    scopes.set(scope, store);
    return store;
  };
});

// A window forwards the store it wraps, refusals from inside a transaction
// included.
describeSessionStore("SessionWindow over InMemorySessionStore", () => {
  const scopes = new Map<string, SessionStore>();
  return (scope) => {
    const store =
      scopes.get(scope) ?? new SessionWindow(new InMemorySessionStore());
    scopes.set(scope, store);
    return store;
  };
});
