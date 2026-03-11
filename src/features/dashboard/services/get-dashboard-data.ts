import { getCurrentUser } from "@/infrastructure/auth/session/get-current-user";

export async function getDashboardData() {
  const user = await getCurrentUser();

  return { email: user?.email ?? null };
}
