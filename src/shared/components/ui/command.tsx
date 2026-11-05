"use client";

import * as React from "react";

import { Command as CommandPrimitive } from "cmdk";
import { Dialog as DialogPrimitive, VisuallyHidden } from "radix-ui";

import { useRestoreFocus } from "@/shared/hooks/use-restore-focus";
import { cn } from "@/shared/utils/cn";

export function Command({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-xl bg-card text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}

type CommandDialogProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root> & {
  /** Accessible dialog title (visually hidden). */
  title: string;
  /** Accessible dialog description (visually hidden). */
  description?: string;
  className?: string;
};

/**
 * Renders children inside an accessible modal dialog. Radix Dialog provides
 * role="dialog", labelling, the focus trap, Escape / overlay-click dismissal,
 * aria-hidden for the rest of the page and body scroll locking; `useRestoreFocus`
 * returns focus to the opener because this dialog is controlled (no `Dialog.Trigger`).
 */
export function CommandDialog({
  title,
  description,
  className,
  children,
  ...props
}: CommandDialogProps) {
  const restoreFocus = useRestoreFocus();

  return (
    <DialogPrimitive.Root {...props}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm" />

        <DialogPrimitive.Content
          // Without a description Radix expects an explicit `aria-describedby={undefined}`.
          {...(description ? {} : { "aria-describedby": undefined })}
          onOpenAutoFocus={restoreFocus.onOpenAutoFocus}
          onCloseAutoFocus={restoreFocus.onCloseAutoFocus}
          className={cn(
            "fixed left-1/2 top-[18vh] z-[101] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card p-0 shadow-2xl outline-none",
            className,
          )}
        >
          <VisuallyHidden.Root>
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
            ) : null}
          </VisuallyHidden.Root>

          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex items-center border-b border-border px-3">
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "flex h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  </div>
));

CommandInput.displayName = "CommandInput";

export const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn("max-h-[300px] overflow-y-auto", className)}
    {...props}
  />
));

CommandList.displayName = "CommandList";

export const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className={cn("py-6 text-center text-sm text-muted-foreground", className)}
    {...props}
  />
));

CommandEmpty.displayName = "CommandEmpty";

export const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      "p-2 text-sm [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
      className,
    )}
    {...props}
  />
));

CommandGroup.displayName = "CommandGroup";

export const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      // cmdk marks the keyboard/pointer-highlighted item with data-selected="true";
      // it must be visibly distinct for keyboard users.
      // Disabled items stay readable (muted token, no blanket opacity) but are clearly
      // inert: not-allowed cursor, never highlighted (cmdk won't select them).
      "flex cursor-pointer select-none items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[selected=true]:bg-muted data-[selected=true]:text-foreground data-[disabled=true]:cursor-not-allowed data-[disabled=true]:text-muted-foreground [&_svg]:shrink-0",
      className,
    )}
    {...props}
  />
));

CommandItem.displayName = "CommandItem";
