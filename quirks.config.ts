import { summarizeCodebase } from "@foundry/quirks/prebuilt";
import { reviewWithArguments } from "./apps/quirks/examples/review-with-arguments";

summarizeCodebase({
  name: "summarize-codebase",
});

reviewWithArguments();
