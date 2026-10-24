"use client";

import * as React from "react";

import { Command as CommandPrimitive } from "cmdk";

export function Command({
  className = "",
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={`flex h-full w-full flex-col overflow-hidden rounded-xl bg-card text-card-foreground ${className}`}
      {...props}
    />
  );
}

export const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className = "", ...props }, ref) => (
  <div className="flex items-center border-b px-3">
    <CommandPrimitive.Input
      ref={ref}
      className={`flex h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground ${className}`}
      {...props}
    />
  </div>
));

CommandInput.displayName = "CommandInput";

export const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className = "", ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={`max-h-[300px] overflow-y-auto ${className}`}
    {...props}
  />
));

CommandList.displayName = "CommandList";

export const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className = "", ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={`p-2 text-sm [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground ${className}`}
    {...props}
  />
));

CommandGroup.displayName = "CommandGroup";

export const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className = "", ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={`flex cursor-pointer select-none items-center rounded-md px-3 py-2 text-sm outline-none hover:bg-muted ${className}`}
    {...props}
  />
));

CommandItem.displayName = "CommandItem";
