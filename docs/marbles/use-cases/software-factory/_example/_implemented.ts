import { workflow } from "@foundry/marbles";
import { implement } from "./_factory/implement";
import { intake } from "./_factory/intake";
import { plan } from "./_factory/plan";
import { issueInput } from "./_factory/record";

workflow("factory")
  .input(issueInput)
  .do(({ input }) => implement({ work: plan({ work: intake({}, input) }) }));
