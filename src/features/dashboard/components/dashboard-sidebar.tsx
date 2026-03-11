"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function DashboardSidebar() {
  const pathname = usePathname();

  const links = [
    { label: "Dashboard", href: "/dashboard" },
    { label: "Billing", href: "/billing" },
    { label: "Settings", href: "/settings" },
  ];

  return (
    <aside className="hidden md:flex w-64 flex-col border-r bg-muted/40 backdrop-blur">
      <div className="flex h-16 items-center px-6 border-b">
        <span className="text-lg font-semibold tracking-tight">Your SaaS</span>
      </div>

      <nav className="flex flex-col gap-1 p-4">
        {links.map((link) => {
          const active = pathname === link.href;

          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-md px-3 py-2 text-sm font-medium transition
                ${
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
