"use client";

import { useEffect } from "react";

import type { LucideIcon } from "lucide-react";

import { Badge } from "@/shared/components/ui/badge";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/components/ui/command";

export type CommandPaletteItem = {
  /** Stable unique identifier, passed back to `onSelect`. */
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Extra terms that should match this item when searching. */
  keywords?: string[];
  /** Listed but not selectable (skipped by keyboard navigation, `onSelect` never fires). */
  disabled?: boolean;
  /** Short trailing hint, e.g. why the item is disabled. */
  hint?: string;
};

export type CommandPaletteGroup = {
  heading: string;
  items: readonly CommandPaletteItem[];
};

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly CommandPaletteGroup[];
  onSelect: (item: CommandPaletteItem) => void;
  placeholder?: string;
  emptyMessage?: string;
  /** Register the global Cmd/Ctrl+K shortcut. Defaults to `true`. */
  hotkey?: boolean;
};

export function isCommandPaletteHotkey(event: KeyboardEvent) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.repeat &&
    event.key.toLowerCase() === "k"
  );
}

/**
 * Generic, fully controlled command palette. Knows nothing about routes or
 * stores: the caller supplies the groups and decides what a selection does.
 */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  onSelect,
  placeholder = "Search pages...",
  emptyMessage = "No results found.",
  hotkey = true,
}: CommandPaletteProps) {
  useEffect(() => {
    if (!hotkey) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCommandPaletteHotkey(event)) return;

      event.preventDefault();
      onOpenChange(!open);
    };

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hotkey, open, onOpenChange]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search for a page and press Enter to navigate."
    >
      <Command label="Command palette" loop>
        <CommandInput placeholder={placeholder} />

        <CommandList>
          <CommandEmpty>{emptyMessage}</CommandEmpty>

          {groups.map((group) => (
            <CommandGroup key={group.heading} heading={group.heading}>
              {group.items.map((item) => {
                const Icon = item.icon;

                return (
                  <CommandItem
                    key={item.id}
                    value={item.label}
                    keywords={item.keywords}
                    disabled={item.disabled}
                    onSelect={() => {
                      if (!item.disabled) onSelect(item);
                    }}
                  >
                    {Icon ? <Icon size={16} aria-hidden="true" /> : null}
                    <span data-slot="command-item-label" className="flex-1 truncate">
                      {item.label}
                    </span>
                    {item.hint ? (
                      <Badge data-slot="command-item-hint" className="ml-auto">
                        {item.hint}
                      </Badge>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
