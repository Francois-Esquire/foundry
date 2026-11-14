import { InMemorySessionStore } from "../../store/memory";
import { describeSessionStore } from "../../testing/store";

describeSessionStore("InMemorySessionStore", () => new InMemorySessionStore());
