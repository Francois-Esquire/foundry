import { type RefObject, useEffect, useRef } from "react";

/** Modal sheets contain focus; a modeless inspector leaves map controls usable. */
export function useSheet(
  open: boolean,
  onClose: () => void,
  trigger: RefObject<HTMLElement | null>,
  mode: "modal" | "modeless" = "modal"
) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element === null) {
      return;
    }
    const cancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    const backdrop = (event: MouseEvent) => {
      const bounds = element.getBoundingClientRect();
      if (
        event.target === element &&
        (event.clientY < bounds.top ||
          event.clientY > bounds.bottom ||
          event.clientX < bounds.left ||
          event.clientX > bounds.right)
      ) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (
        mode === "modeless" &&
        element.open &&
        event.key === "Escape" &&
        !document.querySelector("dialog:modal")
      ) {
        event.preventDefault();
        onClose();
      }
    };
    const keepFocus = (event: KeyboardEvent) => {
      if (mode !== "modal" || event.key !== "Tab") {
        return;
      }
      const elements = [
        ...element.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, summary, a[href]"
        ),
      ].filter((item) => {
        const collapsed = item.closest("details:not([open])");
        return (
          !(item.matches(":disabled") || item.closest("[hidden]")) &&
          (!collapsed || collapsed.querySelector("summary") === item)
        );
      });
      const [first] = elements;
      const last = elements.at(-1);
      if (document.activeElement === (event.shiftKey ? first : last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener("keydown", handleEscape);
    element.addEventListener("cancel", cancel);
    element.addEventListener("close", onClose);
    element.addEventListener("click", backdrop);
    element.addEventListener("keydown", keepFocus);
    return () => {
      document.removeEventListener("keydown", handleEscape);
      element.removeEventListener("cancel", cancel);
      element.removeEventListener("close", onClose);
      element.removeEventListener("click", backdrop);
      element.removeEventListener("keydown", keepFocus);
    };
  }, [mode, onClose]);
  useEffect(() => {
    if (open) {
      if (mode === "modal") {
        dialog.current?.showModal();
      } else {
        dialog.current?.show();
      }
    } else if (dialog.current?.open) {
      dialog.current.style.removeProperty("translate");
      dialog.current.close();
      trigger.current?.focus();
    }
  }, [mode, open, trigger]);
  return dialog;
}
