import { ReactNode } from "react";

import { DashboardHeader, DashboardSidebar } from "@/features/dashboard";
import { CommandPalette } from "@/shared/components/ui/command-palette";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      <DashboardSidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        <DashboardHeader />

        <main className="flex-1 overflow-auto p-6 lg:p-8 bg-secondary/40">
          <div className="mx-auto max-w-7xl space-y-6">{children}</div>
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}
