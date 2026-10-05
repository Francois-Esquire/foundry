import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
import { Action } from "~/components/action";
import { Select } from "~/components/ui/select";
import { useFormFocus } from "~/components/ui/setup-flow";
import { useTheme } from "~/hooks/use-theme";
import {
  type InputField,
  type InputValues,
  inputDefaults,
  inputProblem,
  parseInputs,
} from "~/lib/inputs";

function Field({
  field,
  value,
  focused,
  onChange,
}: {
  readonly field: InputField;
  readonly value?: string | number | boolean;
  readonly focused: boolean;
  readonly onChange: (name: string, value: string | boolean) => void;
}) {
  const theme = useTheme();
  const editor = useRef<TextareaRenderable>(null);
  const change = useCallback(
    (next: string) =>
      onChange(
        field.name,
        field.type === "boolean" && next !== "" ? next === "true" : next
      ),
    [field.name, field.type, onChange]
  );
  const changeText = useCallback(() => {
    const text = editor.current?.plainText;
    if (text !== undefined && text !== value) {
      onChange(field.name, text);
    }
  }, [field.name, onChange, value]);
  if (field.type === "boolean" || field.type === "select") {
    const options =
      field.type === "boolean"
        ? [
            { label: "Yes", value: "true" },
            { label: "No", value: "false" },
          ]
        : (field.options ?? []);
    return (
      <Select
        focused={focused}
        id={`field:${field.name}`}
        onChange={change}
        options={[{ label: "Not set", value: "" }, ...options]}
        value={value === undefined ? "" : String(value)}
      />
    );
  }
  if (field.type === "multiline") {
    return (
      <textarea
        backgroundColor={theme.colors.muted}
        focused={focused}
        height={4}
        id={`field:${field.name}`}
        initialValue={String(value ?? "")}
        onContentChange={changeText}
        ref={editor}
        textColor={theme.colors.foreground}
      />
    );
  }
  return (
    <input
      backgroundColor={theme.colors.muted}
      focused={focused}
      focusedBackgroundColor={theme.colors.muted}
      focusedTextColor={theme.colors.foreground}
      id={`field:${field.name}`}
      onInput={change}
      textColor={theme.colors.foreground}
      value={String(value ?? "")}
    />
  );
}

export function ArgumentForm({
  fields,
  initialValues,
  onSubmit,
  onCancel,
  submitLabel = "Launch",
  busy = false,
  error,
  active = true,
}: {
  readonly fields: readonly InputField[];
  readonly initialValues?: InputValues;
  readonly onSubmit: (input: InputValues) => void;
  readonly onCancel: () => void;
  readonly submitLabel?: string;
  readonly busy?: boolean;
  readonly error?: string;
  readonly active?: boolean;
}) {
  const theme = useTheme();
  const [values, setValues] = useState(
    () => initialValues ?? inputDefaults(fields)
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState(0);
  useFormFocus(
    focus < fields.length
      ? `field:${fields[focus]?.name}`
      : `form:${focus === fields.length ? "submit" : "cancel"}`
  );
  const problem = inputProblem(fields);
  const submit = useCallback(() => {
    if (busy || !active || problem) {
      return;
    }
    const parsed = parseInputs(fields, values);
    setErrors(parsed.errors);
    if (Object.keys(parsed.errors).length === 0) {
      onSubmit(parsed.input);
    }
  }, [active, busy, fields, onSubmit, problem, values]);
  const cancel = useCallback(() => {
    if (!busy && active) {
      onCancel();
    }
  }, [active, busy, onCancel]);
  const changeValue = useCallback(
    (name: string, value: string | boolean) => {
      if (!active || busy) {
        return;
      }
      setValues((previous) => ({ ...previous, [name]: value }));
    },
    [active, busy]
  );
  useKeyboard((key) => {
    if (!active || busy) {
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      onCancel();
    }
    if (key.name === "tab") {
      key.preventDefault();
      setFocus(
        (previous) =>
          (previous + (key.shift ? fields.length + 1 : 1)) % (fields.length + 2)
      );
    }
    if (
      (key.name === "return" || key.name === "enter") &&
      (key.ctrl || focus >= fields.length)
    ) {
      key.preventDefault();
      if (focus === fields.length + 1 && !key.ctrl) {
        onCancel();
      } else {
        submit();
      }
    }
  });
  return (
    <box flexDirection="column" gap={1}>
      {fields.map((field, index) => (
        <box flexDirection="column" key={field.name}>
          <Action
            active={active && focus === index}
            label={`${field.label}${field.required ? " *" : " (optional)"}`}
            onAction={setFocus}
            value={index}
          />
          {field.description && (
            <text fg={theme.colors.mutedForeground}>{field.description}</text>
          )}
          <Field
            field={field}
            focused={active && !busy && focus === index}
            onChange={changeValue}
            value={values[field.name]}
          />
          {errors[field.name] && (
            <text fg={theme.colors.error}>{errors[field.name]}</text>
          )}
        </box>
      ))}
      {(error || problem) && (
        <text fg={theme.colors.error}>{error ?? problem}</text>
      )}
      <box flexDirection="row" gap={3}>
        <Action
          active={focus === fields.length}
          id="form:submit"
          label={busy ? "Please wait..." : submitLabel}
          onAction={submit}
          value="submit"
        />
        <Action
          active={focus === fields.length + 1}
          id="form:cancel"
          label="Back"
          onAction={cancel}
          value="cancel"
        />
      </box>
      <text fg={theme.colors.mutedForeground}>
        Tab focus · ↑↓ choose · Ctrl+Enter {submitLabel.toLowerCase()} · Esc
        back
      </text>
    </box>
  );
}
