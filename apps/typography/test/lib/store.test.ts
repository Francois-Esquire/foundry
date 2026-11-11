import { describe, expect, it } from "vitest";
import { createStore } from "~/lib/store";

describe("createStore", () => {
  it("tells every listener each time the state is set, even to the same value", () => {
    const store = createStore("a");
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    store.setState("b");
    store.setState("b");
    expect(store.getState()).toBe("b");
    expect(heard).toBe(2);
  });

  it("sets the fields it is given and leaves the rest", () => {
    const store = createStore({ name: "Lato", weight: 400 });
    store.patch({ weight: 700 });
    expect(store.getState()).toEqual({ name: "Lato", weight: 700 });
  });

  it("stops telling a listener that was stopped", () => {
    const store = createStore(0);
    let heard = 0;
    const stop = store.subscribe(() => {
      heard += 1;
    });
    store.setState(1);
    stop();
    store.setState(2);
    expect(heard).toBe(1);
  });

  it("tells a listener that another listener stops during the same change", () => {
    const store = createStore(0);
    const heard: string[] = [];
    let stopSecond: () => void = () => undefined;
    store.subscribe(() => {
      heard.push("first");
      stopSecond();
    });
    stopSecond = store.subscribe(() => {
      heard.push("second");
    });
    store.setState(1);
    store.setState(2);
    expect(heard).toEqual(["first", "second", "first"]);
  });
});
