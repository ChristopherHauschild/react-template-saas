import { redirect } from "next/navigation";

import { getCurrentUser } from "../session/get-current-user";

export async function requireAuth() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return user;
}
