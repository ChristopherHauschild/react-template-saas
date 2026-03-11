import { requireGuest } from "@/infrastructure/auth/guards/require-guest";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  await requireGuest();

  return (
    <div className="h-screen grid lg:grid-cols-2 overflow-hidden">
      <div className="hidden lg:flex flex-col justify-between p-12 bg-gradient-to-br from-primary/10 via-background to-background">
        <div className="text-2xl font-semibold">Your SaaS</div>

        <div className="max-w-md space-y-4">
          <h1 className="text-4xl font-bold">Build your SaaS faster</h1>

          <p className="text-muted-foreground">
            Authentication, billing and dashboard ready to use.
          </p>
        </div>

        <p className="text-sm text-muted-foreground">
          © {new Date().getFullYear()} Your SaaS
        </p>
      </div>

      <div className="flex items-center justify-center p-10 bg-muted/30">{children}</div>
    </div>
  );
}
