"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";

import {
  CommandPalette,
  type CommandPaletteGroup,
  type CommandPaletteItem,
} from "@/shared/components/ui/command-palette";

import { DASHBOARD_NAV_ITEMS, UNAVAILABLE_HINT } from "../config/navigation";
import { useCommandPalette } from "../store/useCommandPalette";

/**
 * Wires the generic command palette to the dashboard navigation config and the
 * shared open/closed store (so the header search trigger and Cmd/Ctrl+K agree).
 */
export function DashboardCommandPalette() {
  const router = useRouter();
  const open = useCommandPalette((state) => state.open);
  const setOpen = useCommandPalette((state) => state.setOpen);

  const groups = useMemo<CommandPaletteGroup[]>(
    () => [
      {
        heading: "Navigation",
        items: DASHBOARD_NAV_ITEMS.map((item) => ({
          id: item.href,
          label: item.label,
          icon: item.icon,
          keywords: item.keywords,
          disabled: !item.available,
          hint: item.available ? undefined : UNAVAILABLE_HINT,
        })),
      },
    ],
    [],
  );

  const handleSelect = useCallback(
    (item: CommandPaletteItem) => {
      setOpen(false);
      router.push(item.id);
    },
    [router, setOpen],
  );

  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      groups={groups}
      onSelect={handleSelect}
    />
  );
}
