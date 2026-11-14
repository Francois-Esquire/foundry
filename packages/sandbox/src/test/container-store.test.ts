import { createMemoryContainerStore } from "../store/memory";
import { describeContainerStore } from "../testing/store";

describeContainerStore("memory", createMemoryContainerStore);
