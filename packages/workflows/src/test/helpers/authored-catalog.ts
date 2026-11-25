import type { LinearPlan, StepContract, StepEntry } from "../../authored";

const agentContract: StepContract = {
  inputs: [
    { key: "harness", label: "Harness", required: true, type: "harness" },
    { key: "prompt", label: "Prompt", required: true, type: "text" },
    {
      key: "workspace",
      label: "Workspace",
      required: false,
      type: "workspace",
    },
  ],
  outputs: ["session", "account"],
  rehydrate: "session",
  result: { type: "text" },
};

const textContract: StepContract = {
  inputs: [
    {
      key: "instructions",
      label: "Instructions",
      required: true,
      type: "text",
    },
    { key: "text", label: "Source text", required: false, type: "text" },
  ],
  outputs: ["account"],
  result: { label: "Draft", type: "text" },
};

const documentContract: StepContract = {
  inputs: [
    { key: "content", label: "Document", required: true, type: "text" },
    {
      key: "target",
      label: "Target artifact",
      required: false,
      type: "artifact",
    },
  ],
  outputs: ["artifact"],
  result: { type: "artifact" },
};

const imageContract: StepContract = {
  inputs: [
    { key: "prompt", label: "Prompt", required: true, type: "text" },
    {
      key: "target",
      label: "Target artifact",
      required: false,
      type: "artifact",
    },
  ],
  outputs: ["artifact"],
  result: { type: "artifact" },
};

const notifyContract: StepContract = {
  inputs: [{ key: "note", label: "Note", required: true, type: "text" }],
  outputs: ["account"],
  result: null,
};

const pickerContract: StepContract = {
  inputs: [{ key: "seed", label: "Seed", required: false, type: "text" }],
  outputs: ["artifact"],
  result: { label: "Document", type: "artifact" },
};

export const articleEntries: ReadonlyMap<string, StepEntry> = new Map([
  ["agent", { availability: { status: "available" }, contract: agentContract }],
  ["text", { availability: { status: "available" }, contract: textContract }],
  [
    "document",
    { availability: { status: "available" }, contract: documentContract },
  ],
]);

export const IMAGE_UNAVAILABLE_REASON =
  "the FAL image provider is not registered yet";

export const unavailableEntries: ReadonlyMap<string, StepEntry> = new Map([
  ["text", { availability: { status: "available" }, contract: textContract }],
  [
    "image",
    {
      availability: { reason: IMAGE_UNAVAILABLE_REASON, status: "unavailable" },
      contract: imageContract,
    },
  ],
]);

export const nullResultEntries: ReadonlyMap<string, StepEntry> = new Map([
  [
    "notify",
    { availability: { status: "available" }, contract: notifyContract },
  ],
  ["text", { availability: { status: "available" }, contract: textContract }],
]);

export const labelPrimacyEntries: ReadonlyMap<string, StepEntry> = new Map([
  [
    "picker",
    { availability: { status: "available" }, contract: pickerContract },
  ],
  [
    "document",
    { availability: { status: "available" }, contract: documentContract },
  ],
]);

export const articlePlan: LinearPlan = {
  inputs: [{ key: "topic", label: "Topic", required: true, type: "text" }],
  placements: [
    {
      inputs: {
        harness: { source: "setting", value: "gpt-5" },
        prompt: { input: "topic", source: "run" },
      },
      key: "research",
      step: "agent",
    },
    {
      inputs: {
        instructions: { source: "setting", value: "Write a clear article" },
        text: { placement: "research", source: "connection" },
      },
      key: "write",
      step: "text",
    },
    {
      inputs: { content: { placement: "write", source: "connection" } },
      key: "publish",
      step: "document",
    },
  ],
  schema: 1,
};

export const articlePlanWithRenamedInput: LinearPlan = {
  inputs: [{ key: "topic", label: "Topic", required: true, type: "text" }],
  placements: [
    {
      inputs: {
        harness: { source: "setting", value: "gpt-5" },
        prompt: { input: "topic", source: "run" },
      },
      key: "research",
      step: "agent",
    },
    {
      inputs: {
        prompt: { source: "setting", value: "Write a clear article" },
        text: { placement: "research", source: "connection" },
      },
      key: "write",
      step: "text",
    },
    {
      inputs: { content: { placement: "write", source: "connection" } },
      key: "publish",
      step: "document",
    },
  ],
  schema: 1,
};

export const declaredUnusedPlan: LinearPlan = {
  inputs: [
    { key: "topic", label: "Topic", required: true, type: "text" },
    { key: "spare", label: "Spare", required: false, type: "text" },
  ],
  placements: [
    {
      inputs: {
        harness: { source: "setting", value: "gpt-5" },
        prompt: { input: "topic", source: "run" },
      },
      key: "research",
      step: "agent",
    },
  ],
  schema: 1,
};

export const threeDefectsPlan: LinearPlan = {
  inputs: [],
  placements: [
    {
      inputs: {
        harness: { source: "setting", value: "" },
        nonsense: { source: "setting", value: "x" },
      },
      key: "bad",
      step: "agent",
    },
  ],
  schema: 1,
};

export const unavailablePlan: LinearPlan = {
  inputs: [],
  placements: [
    {
      inputs: { instructions: { source: "setting", value: "hello" } },
      key: "draft",
      step: "text",
    },
    {
      inputs: {
        bogus: { source: "setting", value: "x" },
        prompt: { input: "missing", source: "run" },
      },
      key: "render",
      step: "image",
    },
  ],
  schema: 1,
};

export const forwardPlan: LinearPlan = {
  inputs: [],
  placements: [
    {
      inputs: {
        instructions: { source: "setting", value: "x" },
        text: { placement: "second", source: "connection" },
      },
      key: "first",
      step: "text",
    },
    {
      inputs: { instructions: { source: "setting", value: "y" } },
      key: "second",
      step: "text",
    },
  ],
  schema: 1,
};

export const selfConnectionPlan: LinearPlan = {
  inputs: [],
  placements: [
    {
      inputs: {
        instructions: { source: "setting", value: "x" },
        text: { placement: "loop", source: "connection" },
      },
      key: "loop",
      step: "text",
    },
  ],
  schema: 1,
};

export const nullResultPlan: LinearPlan = {
  inputs: [],
  placements: [
    {
      inputs: { note: { source: "setting", value: "hi" } },
      key: "announce",
      step: "notify",
    },
    {
      inputs: {
        instructions: { source: "setting", value: "z" },
        text: { placement: "announce", source: "connection" },
      },
      key: "consume",
      step: "text",
    },
  ],
  schema: 1,
};

export const labelPrimacyPlan: LinearPlan = {
  inputs: [],
  placements: [
    { inputs: {}, key: "pick", step: "picker" },
    {
      inputs: { content: { placement: "pick", source: "connection" } },
      key: "render",
      step: "document",
    },
  ],
  schema: 1,
};

export const runTypeMismatchPlan: LinearPlan = {
  inputs: [{ key: "pic", label: "Pic", required: true, type: "artifact" }],
  placements: [
    {
      inputs: {
        harness: { source: "setting", value: "gpt-5" },
        prompt: { input: "pic", source: "run" },
      },
      key: "research",
      step: "agent",
    },
  ],
  schema: 1,
};

export const runMissingRequiredPlan: LinearPlan = {
  inputs: [{ key: "topic", label: "Topic", required: false, type: "text" }],
  placements: [
    {
      inputs: {
        harness: { source: "setting", value: "gpt-5" },
        prompt: { input: "topic", source: "run" },
      },
      key: "research",
      step: "agent",
    },
  ],
  schema: 1,
};

export const notAdmittedPlan: LinearPlan = {
  inputs: [],
  placements: [{ inputs: {}, key: "solo", step: "ghost" }],
  schema: 1,
};

export const emptyPlan: LinearPlan = {
  inputs: [],
  placements: [],
  schema: 1,
};

export const duplicatePlacementPlan: LinearPlan = {
  inputs: [],
  placements: [
    {
      inputs: { instructions: { source: "setting", value: "a" } },
      key: "dup",
      step: "text",
    },
    {
      inputs: { instructions: { source: "setting", value: "b" } },
      key: "dup",
      step: "text",
    },
  ],
  schema: 1,
};

export const unknownPlacementPlan: LinearPlan = {
  inputs: [],
  placements: [
    {
      inputs: {
        instructions: { source: "setting", value: "x" },
        text: { placement: "ghost", source: "connection" },
      },
      key: "consume",
      step: "text",
    },
  ],
  schema: 1,
};

export const duplicateRunInputPlan: LinearPlan = {
  inputs: [
    { key: "topic", label: "Topic", required: true, type: "text" },
    { key: "topic", label: "Topic again", required: true, type: "text" },
  ],
  placements: [
    {
      inputs: {
        harness: { source: "setting", value: "gpt-5" },
        prompt: { input: "topic", source: "run" },
      },
      key: "research",
      step: "agent",
    },
  ],
  schema: 1,
};

export const emptyTextSettingPlan: LinearPlan = {
  inputs: [],
  placements: [
    {
      inputs: { instructions: { source: "setting", value: "" } },
      key: "draft",
      step: "text",
    },
  ],
  schema: 1,
};
