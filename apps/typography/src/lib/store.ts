/**
 * A value that can be watched: the state a session, a workspace or a holder
 * keeps, and the listeners that are told when it is set.
 */
export interface Store<State> {
  getState(): State;
  /**
   * Sets the listed fields and leaves the rest. Tells every listener, unless
   * every listed field already holds that very value: a change that changes
   * nothing leaves the state as it is and tells no one.
   */
  patch(fields: Partial<State>): void;
  /** Replaces the state. Tells every listener, whether or not it differs. */
  setState(next: State): void;
  /** Returns a function that stops the listener. */
  subscribe(listener: () => void): () => void;
}

export const createStore = <State>(initial: State): Store<State> => {
  let state = initial;
  const listeners = new Set<() => void>();
  const setState = (next: State) => {
    state = next;
    // A copy, so a listener that stops itself or another is still told once.
    for (const listener of [...listeners]) {
      listener();
    }
  };
  return {
    getState: () => state,
    patch(fields) {
      const changes = Object.entries(fields).some(
        ([field, value]) => value !== state[field as keyof State]
      );
      if (changes) {
        setState({ ...state, ...fields });
      }
    },
    setState,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
