import { InMemoryArtifactStore } from "../memory";
import { describeArtifactStore } from "../testing/store";
import { describeArtifactSystem } from "../testing/system";

const store = () => new InMemoryArtifactStore();
describeArtifactStore("In-memory", store);
describeArtifactSystem("In-memory", store);
