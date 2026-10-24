"use client";

import { PanelLeft } from "lucide-react";

import { Avatar, AvatarFallback } from "@/shared/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { SearchInput } from "@/shared/components/ui/search-input";

import { useSidebar } from "../store/useSidebar";

export function DashboardHeader() {
  const { toggle } = useSidebar();

  return (
    <header className="flex h-16 items-center justify-between border-b border-border bg-foreground px-6 text-background">
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          className="flex h-9 w-9 items-center justify-center rounded-md transition hover:bg-white/10"
        >
          <PanelLeft size={18} />
        </button>

        <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
      </div>

      <div className="flex items-center gap-6">
        <SearchInput />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-3 rounded-full px-2 py-1 transition hover:bg-white/10">
              <Avatar>
                <AvatarFallback>CH</AvatarFallback>
              </Avatar>

              <span className="text-sm font-medium">Chris</span>
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="end"
            className="w-48 bg-card border border-border shadow-lg"
          >
            <DropdownMenuLabel>Chris</DropdownMenuLabel>

            <DropdownMenuSeparator />

            <DropdownMenuItem>Profile</DropdownMenuItem>
            <DropdownMenuItem>Settings</DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
