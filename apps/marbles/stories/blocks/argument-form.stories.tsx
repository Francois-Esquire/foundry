import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { ArgumentForm } from "~/components/blocks/argument-form";
import { Text } from "~/components/ui/text";
import {
  type InputField,
  type InputValues,
  inputDefaults,
  inputProblem,
  parseInputs,
} from "~/lib/inputs";
import { ignore, renderFrame } from "../frame";

const size = { height: 34, width: 72 };

const fields: readonly InputField[] = [
  {
    description: "The branch whose changes are documented.",
    label: "Branch",
    name: "branch",
    required: true,
    type: "text",
  },
  {
    default: 3,
    description: "How many pages to rewrite at most.",
    label: "Page limit",
    max: 20,
    min: 1,
    name: "limit",
    type: "number",
  },
  {
    default: true,
    label: "Run checks",
    name: "check",
    type: "boolean",
  },
  {
    default: "reference",
    label: "Section",
    name: "section",
    options: [
      { label: "Reference", value: "reference" },
      { label: "Guides", value: "guides" },
      { label: "Changelog", value: "changelog" },
    ],
    required: true,
    type: "select",
  },
  {
    description: "Extra instructions for the writer.",
    label: "Notes",
    name: "notes",
    type: "multiline",
  },
];

const parse = (values: InputValues) => parseInputs(fields, values);

function Form({
  active,
  busy,
  error,
  formFields = fields,
  initialValues = inputDefaults(fields),
  submitLabel,
}: {
  readonly active?: boolean;
  readonly busy?: boolean;
  readonly error?: string;
  readonly formFields?: readonly InputField[];
  readonly initialValues?: InputValues;
  readonly submitLabel?: string;
}) {
  const parseFields = useCallback(
    (values: InputValues) => parseInputs(formFields, values),
    [formFields]
  );
  return (
    <ArgumentForm
      fields={formFields}
      initialValues={initialValues}
      onCancel={ignore}
      onSubmit={ignore}
      parse={parseFields}
      problem={inputProblem(formFields)}
      {...(active === undefined ? {} : { active })}
      {...(busy === undefined ? {} : { busy })}
      {...(error === undefined ? {} : { error })}
      {...(submitLabel === undefined ? {} : { submitLabel })}
    />
  );
}

function LaunchForm() {
  const [outcome, setOutcome] = useState("Nothing launched yet");
  const submit = useCallback(
    (input: InputValues) =>
      setOutcome(`Launched with ${JSON.stringify(input)}`),
    []
  );
  const cancel = useCallback(() => setOutcome("Went back"), []);
  return (
    <>
      <ArgumentForm
        fields={fields}
        initialValues={inputDefaults(fields)}
        onCancel={cancel}
        onSubmit={submit}
        parse={parse}
      />
      <Text>{outcome}</Text>
    </>
  );
}

export default defineStories({
  component: "ArgumentForm",
  description:
    "The launch form: one control per declared argument, then Launch and Back.",
  title: "Blocks/ArgumentForm",
});

export const Launch = story({
  description:
    "A working form with every field type. Tab moves focus and Enter on Launch submits; leave Branch empty to see its error.",
  name: "Launch",
  render: (renderer) => renderFrame(renderer, <LaunchForm />, size),
});

export const Filled = story({
  description: "Every field already holds a value.",
  name: "Filled",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Form
        initialValues={{
          branch: "feat/feed-answers",
          check: false,
          limit: 8,
          notes: "Keep the examples short.",
          section: "guides",
        }}
      />,
      size
    ),
});

export const Busy = story({
  description:
    "Waiting for the launch to start; the submit label changes and input is ignored.",
  name: "Busy",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Form
        busy
        initialValues={{ ...inputDefaults(fields), branch: "main" }}
      />,
      size
    ),
});

export const LaunchError = story({
  description: "A launch the host refused, with its error above the buttons.",
  name: "Launch error",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Form
        error="Another run of update-documentation is already queued."
        initialValues={{ ...inputDefaults(fields), branch: "main" }}
      />,
      size
    ),
});

export const Problem = story({
  description:
    "Arguments the form cannot show: a select with no choices blocks launching.",
  name: "Configuration problem",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Form
        formFields={[
          fields[0] as InputField,
          { label: "Target", name: "target", required: true, type: "select" },
        ]}
        initialValues={{}}
      />,
      { height: 18, width: 72 }
    ),
});

export const Inactive = story({
  description:
    "An inactive form, as behind the quit dialog: no field is focused and keys are ignored.",
  name: "Inactive",
  render: (renderer) => renderFrame(renderer, <Form active={false} />, size),
});

export const CustomSubmit = story({
  description:
    "A custom submit label, as onboarding uses; the hint line follows it.",
  name: "Custom submit label",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Form
        formFields={fields.slice(0, 2)}
        initialValues={{ limit: 3 }}
        submitLabel="Create workspace"
      />,
      { height: 16, width: 72 }
    ),
});

export const NoFields = story({
  description: "A definition with no arguments: only the buttons and hint.",
  name: "No fields",
  render: (renderer) =>
    renderFrame(renderer, <Form formFields={[]} initialValues={{}} />, {
      height: 8,
      width: 72,
    }),
});

export const Narrow = story({
  description: "The form in a narrow column; descriptions and the hint wrap.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(renderer, <Form />, { height: 40, width: 36 }),
});
