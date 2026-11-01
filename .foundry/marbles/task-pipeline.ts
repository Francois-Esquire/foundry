import { standardDestinations } from "../../apps/marbles/examples/task-pipeline/destinations";
import { taskPipeline } from "../../apps/marbles/examples/task-pipeline/pipeline";

taskPipeline({ destinations: standardDestinations() });
