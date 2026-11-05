import { requireAuth } from "@/infrastructure/auth/guards/require-auth";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Everything under (protected) — dashboard, pricing — requires a signed-in user.
  await requireAuth();

  return <>{children}</>;
}
