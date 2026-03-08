import { requireGuest } from "@/infrastructure/auth/guards/require-guest";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  await requireGuest();

  return <>{children}</>;
}
