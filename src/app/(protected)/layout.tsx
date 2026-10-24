// import { requireAuth } from "@/infrastructure/auth/guards/require-auth";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // await requireAuth();

  return <>{children}</>;
}
