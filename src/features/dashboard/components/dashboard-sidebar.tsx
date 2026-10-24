"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { CreditCard, LayoutDashboard, Settings } from "lucide-react";

import { useSidebar } from "../store/useSidebar";

export function DashboardSidebar() {
  const pathname = usePathname();
  const { collapsed } = useSidebar();

  const nav = [
    {
      label: "Dashboard",
      href: "/dashboard",
      icon: LayoutDashboard,
    },
    {
      label: "Billing",
      href: "/billing",
      icon: CreditCard,
    },
    {
      label: "Settings",
      href: "/settings",
      icon: Settings,
    },
  ];

  return (
    <aside
      className={`hidden md:flex flex-col border-r border-border bg-primary/10 transition-all duration-300
      ${collapsed ? "w-16" : "w-64"}`}
    >
      <div
        className={`flex h-16 items-center font-semibold text-primary
        ${collapsed ? "justify-center" : "px-6"}`}
      >
        {collapsed ? "S" : "Your SaaS"}
      </div>

      <nav className="flex flex-col gap-1 px-2 py-4">
        {nav.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center rounded-lg px-3 py-2 text-sm font-medium transition
              ${
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-foreground/70 hover:bg-primary/20"
              }
              ${collapsed ? "justify-center" : "gap-3"}`}
            >
              <Icon size={18} />

              {!collapsed && item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
