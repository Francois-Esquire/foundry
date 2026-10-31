import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type ReactNode, useCallback, useState } from "react";
import { Button } from "./button";

/**
 * An open modal with a title, a description and a close button. Focus
 * moves in when it mounts, stays inside, and returns to the element that
 * had it once the dialog unmounts.
 */
export function Dialog({
  children,
  description,
  onClose,
  title,
}: {
  children?: ReactNode;
  description: ReactNode;
  /** Escape, the overlay and the close button all close it. */
  onClose: () => void;
  title: string;
}) {
  // Opened without a Radix trigger, so focus returns to what had it before.
  const [returnTo] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  );
  const restoreFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      returnTo?.focus();
    },
    [returnTo]
  );
  const change = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );
  return (
    <DialogPrimitive.Root onOpenChange={change} open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          className="fixed top-1/2 left-1/2 z-50 max-h-[80vh] w-full max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl bg-popover p-6 text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
          onCloseAutoFocus={restoreFocus}
        >
          <div className="flex items-start gap-3">
            <DialogPrimitive.Title className="min-w-0 flex-1 font-semibold text-base">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button aria-label="Close" size="icon-sm" variant="ghost">
                <XIcon />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="mt-2 text-muted-foreground text-sm">
            {description}
          </DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
