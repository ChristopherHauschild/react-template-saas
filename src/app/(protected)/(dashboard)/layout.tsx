import { ReactNode } from "react";

import { signOut } from "@/features/auth/actions/sign-out";
import {
  DashboardCommandPalette,
  DashboardHeader,
  DashboardSidebar,
  toAccountMenuUser,
} from "@/features/dashboard";
import { getCurrentUser } from "@/infrastructure/auth/session/get-current-user";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Same per-request cached lookup the (protected) layout's guard already made —
  // no additional round trip to Supabase. Only derived display strings are passed
  // to the client component.
  const user = toAccountMenuUser(await getCurrentUser());

  return (
    <div className="flex min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[110] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>

      <DashboardSidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        <DashboardHeader user={user} signOutAction={signOut} />

        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-auto p-6 lg:p-8 bg-secondary/40 outline-none"
        >
          <div className="mx-auto max-w-7xl space-y-6">{children}</div>
        </main>
      </div>

      <DashboardCommandPalette />
    </div>
  );
}
