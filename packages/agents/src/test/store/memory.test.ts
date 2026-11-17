import { SessionWindow } from "../../contexts/session-window";
import type { SessionStore } from "../../store";
import { InMemorySessionStore } from "../../store/memory";
import { describeSessionStore } from "../../testing/store";

describeSessionStore("InMemorySessionStore", () => {
  const scopes = new Map<string, SessionStore>();
  return (scope) => {
    const store = scopes.get(scope) ?? new InMemorySessionStore();
    scopes.set(scope, store);
    return store;
  };
});

describeSessionStore("SessionWindow over InMemorySessionStore", () => {
  const scopes = new Map<string, SessionStore>();
  return (scope) => {
    const store =
      scopes.get(scope) ?? new SessionWindow(new InMemorySessionStore());
    scopes.set(scope, store);
    return store;
  };
});
