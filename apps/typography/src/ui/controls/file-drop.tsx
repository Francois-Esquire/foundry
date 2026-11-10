import "./file-drop.css";
import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { LineSymbol } from "../symbols/line-symbol";
import {
  describeAccepted,
  describeRejected,
  type FileRejection,
  type SortedFiles,
  sortFiles,
} from "./file-sorting";
import { Notice } from "./notice";

interface FileDropProps {
  /** Accepted file extensions with their dot, such as ".ttf". */
  readonly accept: readonly string[];
  readonly disabled?: boolean;
  /** Names the action, such as "Add font files". */
  readonly label: string;
  readonly multiple?: boolean;
  /** Called with every offer that holds at least one file. */
  readonly onFiles: (files: SortedFiles) => void;
}

/**
 * A place to drop files or choose them. A real file input covers the whole
 * target, so a click, Enter or Space opens the file chooser and dropped
 * files are checked the same way as chosen ones.
 */
export function FileDrop({
  accept,
  disabled,
  label,
  multiple = true,
  onFiles,
}: FileDropProps) {
  const id = useId();
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<readonly FileRejection[]>([]);

  const offer = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) {
        return;
      }
      const sorted = sortFiles(files, accept, multiple);
      setRejected(sorted.rejected);
      onFiles(sorted);
    },
    [accept, multiple, onFiles]
  );

  const choose = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      offer(Array.from(event.currentTarget.files ?? []));
      // Lets the same file be chosen again after it was removed elsewhere.
      event.currentTarget.value = "";
    },
    [offer]
  );

  const enter = useCallback(() => setOver(true), []);
  const leave = useCallback(() => setOver(false), []);
  const hold = useCallback((event: DragEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);
  const drop = useCallback(
    (event: DragEvent<HTMLInputElement>) => {
      event.preventDefault();
      setOver(false);
      offer(Array.from(event.dataTransfer.files));
    },
    [offer]
  );
  const dismiss = useCallback(() => setRejected([]), []);

  return (
    <div className="ty-file-drop">
      <div className="ty-file-drop-target" data-over={over}>
        <LineSymbol name="import" />
        <div className="ty-file-drop-text">
          <label className="ty-label" htmlFor={id}>
            {label}
          </label>
          <p id={`${id}-hint`}>
            Drop files here or choose them. {describeAccepted(accept)}
          </p>
        </div>
        <span aria-hidden="true" className="ty-label ty-file-drop-choose">
          Choose files
        </span>
        <input
          accept={accept.join(",")}
          aria-describedby={`${id}-hint`}
          className="ty-file-drop-input"
          disabled={disabled}
          id={id}
          multiple={multiple}
          onChange={choose}
          onDragEnter={enter}
          onDragLeave={leave}
          onDragOver={hold}
          onDrop={drop}
          type="file"
        />
      </div>
      {rejected.length > 0 ? (
        <Notice onDismiss={dismiss} tone="problem">
          {describeRejected(rejected, accept)}
        </Notice>
      ) : null}
    </div>
  );
}
