import { workflow } from "@foundry.sh/marbles";
import { intake } from "./_factory/intake";
import { issueInput } from "./_factory/record";

workflow("factory")
  .input(issueInput)
  .do(({ input }) => intake({}, input));
