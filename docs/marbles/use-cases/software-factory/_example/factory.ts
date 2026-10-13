import { workflow } from "@foundry/marbles";
import { implement } from "./_factory/implement";
import { intake } from "./_factory/intake";
import { plan } from "./_factory/plan";
import { issueInput } from "./_factory/record";
import { revise, revisionInput } from "./_factory/revise";
import { verify } from "./_factory/verify";

workflow("factory")
  .input(issueInput)
  .do(({ input }) =>
    verify({ work: implement({ work: plan({ work: intake({}, input) }) }) })
  );

workflow("factory-revise")
  .input(revisionInput)
  .do(({ input }) => verify({ work: implement({ work: revise({}, input) }) }));
