import { workflow } from "@foundry.sh/marbles";
import { intake } from "./_factory/intake";
import { plan } from "./_factory/plan";
import { issueInput } from "./_factory/record";

workflow("factory")
  .input(issueInput)
  .do(({ input }) => plan({ work: intake({}, input) }));
