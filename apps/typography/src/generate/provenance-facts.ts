/**
 * A candidate's provenance as the labelled facts printed beside it. Replayed
 * output is always called a recorded run, and a charge nobody stated is
 * never printed as a number.
 */
import type { RunRecord } from "~/generation/pipeline/run";
import { type Making, makingOf, type Provenance } from "~/typeface/provenance";
import { formatCost } from "./cost";
import { strategyLabel } from "./strategies";

export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** The plain label for where output came from. */
export const RECORDED_LABEL = "Recorded run";

const WHEN = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
});

/** An ISO time as a person reads it, in their own time zone. */
export const formatWhen = (iso: string) => {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : WHEN.format(time);
};

type Generated = Extract<Provenance, { readonly origin: "generated" }>;

/** How a run made its output, as the value of a fact. */
export const SOURCE_WORDS: Readonly<Record<Making, string>> = {
  model: "Live model run",
  recorded: `${RECORDED_LABEL}, replayed. Not live model output`,
  rule: "Built by rule on this machine",
};

const costOf = (provenance: Generated, record: RunRecord) =>
  provenance.model || record.costUsd !== undefined
    ? formatCost(record.costUsd)
    : "None. No model was called";

/** The facts for one candidate, from its own provenance and the record of the run that made it. */
export const provenanceFacts = (
  provenance: Provenance,
  record: RunRecord
): Fact[] => {
  if (provenance.origin !== "generated") {
    return [];
  }
  return [
    { label: "Source", value: SOURCE_WORDS[makingOf(provenance)] },
    { label: "Strategy", value: strategyLabel(provenance.strategy) },
    { label: "Model", value: provenance.model ?? "None" },
    {
      label: provenance.recorded ? "Model called" : "Made",
      value: formatWhen(provenance.createdAt),
    },
    { label: "Cost", value: costOf(provenance, record) },
  ];
};
