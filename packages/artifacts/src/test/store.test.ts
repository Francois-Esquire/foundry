import { InMemoryArtifactStore } from "../store/memory";
import { describeArtifactManager } from "../testing/manager";
import { describeArtifactStore } from "../testing/store";

const store = () => new InMemoryArtifactStore();
describeArtifactStore("In-memory", store);
describeArtifactManager("In-memory", store);
