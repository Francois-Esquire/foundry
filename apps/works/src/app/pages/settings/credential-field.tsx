import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { Button } from "~/app/components/button";
import { Input } from "~/app/components/input";
import { SourceBadge } from "~/app/components/source-badge";
import type { FieldState, VaultField, VaultFieldKind } from "~/shared/vault";

const INPUT_TYPES: Record<VaultFieldKind, "password" | "text" | "url"> = {
  secret: "password",
  text: "text",
  url: "url",
};

const MASK = "••••••••••••••••••••";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validate(field: VaultField, value: string): string | null {
  if (field.kind === "url" && !isHttpUrl(value)) {
    return "Enter a valid http(s) URL.";
  }
  return null;
}

function placeholderFor(field: VaultField, state: FieldState): string {
  if (!state.isSet) {
    return field.placeholder ?? "";
  }
  return field.kind === "secret" ? MASK : "Configured";
}

export interface CredentialFieldProps {
  field: VaultField;
  onClear: (key: string) => void;
  onSave: (key: string, value: string) => void;
  state: FieldState;
}

/**
 * One credential: a labelled input with its source badge, Save, and, when the
 * value is user-set, Clear. The input never shows a stored value; it only
 * takes a new one.
 */
export function CredentialField({
  field,
  onClear,
  onSave,
  state,
}: CredentialFieldProps) {
  const inputId = useId();
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const error = trimmed.length > 0 ? validate(field, trimmed) : null;
  const canSave = trimmed.length > 0 && error === null;

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setValue(event.target.value);
  }, []);

  const handleSave = useCallback(() => {
    if (!canSave) {
      return;
    }
    onSave(field.key, trimmed);
    setValue("");
  }, [canSave, field.key, onSave, trimmed]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        handleSave();
      }
    },
    [handleSave]
  );

  const handleClear = useCallback(() => {
    onClear(field.key);
  }, [field.key, onClear]);

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <label
          className="font-medium text-foreground text-xs leading-none"
          htmlFor={inputId}
        >
          {field.label}
        </label>
        <SourceBadge source={state.source} />
      </div>
      <div className="flex gap-2">
        <Input
          aria-invalid={error !== null}
          autoComplete="off"
          id={inputId}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholderFor(field, state)}
          type={INPUT_TYPES[field.kind]}
          value={value}
        />
        <Button
          disabled={!canSave}
          onClick={handleSave}
          size="sm"
          variant="outline"
        >
          Save
        </Button>
        {state.source === "store" ? (
          <Button
            className="text-muted-foreground hover:text-destructive"
            onClick={handleClear}
            size="sm"
            variant="ghost"
          >
            Clear
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="mt-1.5 text-amber-600 text-xs dark:text-amber-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
