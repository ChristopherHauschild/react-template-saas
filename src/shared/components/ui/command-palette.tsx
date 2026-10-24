"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/components/ui/command";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();

        setOpen((prev) => !prev);
      }

      if (e.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", down);

    return () => document.removeEventListener("keydown", down);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 backdrop-blur-sm pt-[18vh]">
      <div className="w-full max-w-xl">
        <Command className="w-full border border-border shadow-2xl rounded-xl">
          <CommandInput placeholder="Search pages..." />

          <CommandList>
            <CommandGroup heading="Navigation">
              <CommandItem onSelect={() => router.push("/dashboard")}>
                Dashboard
              </CommandItem>

              <CommandItem onSelect={() => router.push("/billing")}>Billing</CommandItem>

              <CommandItem onSelect={() => router.push("/settings")}>
                Settings
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    </div>
  );
}
