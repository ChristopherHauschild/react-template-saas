"use client";

export function DashboardHeader() {
  return (
    <header className="flex h-16 items-center justify-between border-b bg-background/80 backdrop-blur px-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
      </div>

      <div className="flex items-center gap-4">
        <button className="text-sm text-muted-foreground hover:text-foreground transition">
          Sign out
        </button>
      </div>
    </header>
  );
}
